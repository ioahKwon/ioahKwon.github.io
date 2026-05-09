/*
  Joonwoo Kwon Studio — interactive painting
  ------------------------------------------------------------
  The oil painting is rendered as a living canvas you can drag with the
  cursor. Every frame a GPGPU pass updates a "painted" float texture by:

    1. advecting the previous state slightly along the current mouse
       velocity (oil-smear),
    2. lerping back toward the original painting at a slow rate
       (self-healing — the canvas eventually reverts to the source),
    3. depositing fresh paint along the active stroke, where the brush
       color is sampled from the ORIGINAL image so drags "pick up" the
       true pigment under the cursor.

  This is the "physics-informed" bit: the smear is an advection step of a
  velocity field driven by the viewer's hand, the restoration is a linear
  diffusion toward the source, and the deposit is a Gaussian kernel.
*/

import * as THREE from 'three';

(function () {
  const canvas   = document.getElementById('studio-canvas');
  const box      = document.getElementById('gallery-box');
  const enterBtn = document.getElementById('enter-btn');
  if (!canvas || !box) return;

  function getBoxSize() {
    const r = box.getBoundingClientRect();
    return { w: Math.max(2, Math.floor(r.width)), h: Math.max(2, Math.floor(r.height)) };
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  const initSize = getBoxSize();
  renderer.setSize(initSize.w, initSize.h, false);
  renderer.setClearColor(0x000000, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Debug: detect WebGL context loss — if this fires, we know the GPU
  // is resetting the context and that's the flicker source.
  canvas.addEventListener('webglcontextlost', (e) => {
    console.error('[studio.js] WebGL context LOST');
    e.preventDefault();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    console.warn('[studio.js] WebGL context RESTORED — re-seeding');
    if (paintingLoaded) {
      paintingTex.needsUpdate = true;
      seedPaintedRTs();
      displayUniforms.uPainted.value = paintedA.texture;
    }
  });

  const displayScene  = new THREE.Scene();
  const displayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---------- Gallery: multiple paintings ----------
  const GALLERY_SRCS = [
    'image/landing_portrait.jpg',
    'image/portrait2_original.jpg',
  ];
  let currentIndex = 0;
  let paintingReady = false;
  let paintingLoaded = false;

  const paintingTex = new THREE.Texture();
  paintingTex.colorSpace = THREE.SRGBColorSpace;
  paintingTex.minFilter  = THREE.LinearFilter;
  paintingTex.magFilter  = THREE.LinearFilter;
  paintingTex.wrapS = THREE.ClampToEdgeWrapping;
  paintingTex.wrapT = THREE.ClampToEdgeWrapping;

  // Preload all gallery images as separate THREE.Texture objects so
  // swapping between them is a clean GPU texture switch, not a
  // same-object image swap that Three.js might ignore.
  const galleryTextures = GALLERY_SRCS.map(() => null);

  function loadGalleryImage(index) {
    function applyTexture(tex) {
      console.log('[studio.js] switching to image', index);
      currentIndex = index;
      seedMat.uniforms.uTex.value = tex;
      updateUniforms.uSrc.value = tex;
      displayUniforms.uSrc.value = tex;
      displayUniforms.uImgAspect.value = tex.image.width / tex.image.height;
      // Reset drip timer so drips start fresh on each painting
      displayUniforms.uDripTime.value = 0;
      seedPaintedRTs();
      displayUniforms.uPainted.value = paintedA.texture;
      paintingReady = true;
      paintingLoaded = true;
      document.querySelectorAll('.gallery-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
      });
    }

    // If already loaded, just apply
    if (galleryTextures[index]) {
      applyTexture(galleryTextures[index]);
      return;
    }

    // Load fresh
    const img = new Image();
    img.onload = () => {
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      galleryTextures[index] = tex;
      applyTexture(tex);
    };
    img.onerror = () => console.error('[studio.js] failed to load', GALLERY_SRCS[index]);
    img.src = GALLERY_SRCS[index];
  }

  // Dot navigation (initial load deferred until seedMat is defined)
  document.querySelectorAll('.gallery-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      const idx = parseInt(dot.dataset.index);
      if (idx !== currentIndex) loadGalleryImage(idx);
    });
  });

  // Prev / next arrow navigation (cycles through GALLERY_SRCS)
  function stepGallery(delta) {
    const n = GALLERY_SRCS.length;
    const next = (currentIndex + delta + n) % n;
    if (next !== currentIndex) loadGalleryImage(next);
  }
  const prevBtn = document.getElementById('gallery-prev');
  const nextBtn = document.getElementById('gallery-next');
  if (prevBtn) prevBtn.addEventListener('click', () => stepGallery(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => stepGallery(1));
  // Keyboard arrows for gallery navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft')  stepGallery(-1);
    if (e.key === 'ArrowRight') stepGallery(1);
  });

  // ---------- Painted-state GPGPU (ping-pong) ----------
  // R,G,B = current painted color. A = "dirt" level (how far from original),
  // used to gate the restoration speed so fresh strokes heal faster than
  // ambient drift.
  const PAINT_SIZE = 1024;  // high res so brushstrokes stay crisp

  const rtParams = {
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    // Half-float is the only float RT widely supported on WebGL2 without
    // EXT_color_buffer_float. Full float renders broke on this machine.
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  };
  let paintedA = new THREE.WebGLRenderTarget(PAINT_SIZE, PAINT_SIZE, rtParams);
  let paintedB = new THREE.WebGLRenderTarget(PAINT_SIZE, PAINT_SIZE, rtParams);

  const quadGeo = new THREE.PlaneGeometry(2, 2);

  // ----- Seed pass: copies the source image into both painted RTs -----
  const seedMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: paintingTex } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      uniform sampler2D uTex;
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(uTex, vUv);
        gl_FragColor = vec4(c.rgb, 0.0);
      }
    `,
  });
  const seedScene = new THREE.Scene();
  seedScene.add(new THREE.Mesh(quadGeo, seedMat));

  function seedPaintedRTs() {
    renderer.setRenderTarget(paintedA);
    renderer.render(seedScene, displayCamera);
    renderer.setRenderTarget(paintedB);
    renderer.render(seedScene, displayCamera);
    renderer.setRenderTarget(null);
  }

  // ----- Update pass: smear + restore + brush deposit -----
  // The brush is expressed in "source UV" — the painting's own texture
  // coordinates — so we convert the mouse canvas coords once per frame.
  const updateUniforms = {
    uPrev:       { value: null },
    uSrc:        { value: paintingTex },
    uImgAspect:  { value: 1.0 },
    uCanvasAspect: { value: 1.0 },
    uMousePrev:  { value: new THREE.Vector2(-10, -10) },
    uMouseCurr:  { value: new THREE.Vector2(-10, -10) },
    uMouseDown:  { value: 0 },
    uBrushSize:  { value: 0.028 },
    uBrushStrength: { value: 1.0 },
    uRestore:    { value: 0.0018 },  // ~30 s full restore
    uSmear:      { value: 0.85 },
    uDt:         { value: 1/60 },
    uDripRate:   { value: 0.22 },
    uDripDiffuse:{ value: 0.6 },
  };

  const updateFrag = /* glsl */`
    precision highp float;
    uniform sampler2D uPrev;
    uniform sampler2D uSrc;
    uniform float uImgAspect;
    uniform float uCanvasAspect;
    uniform vec2  uMousePrev;
    uniform vec2  uMouseCurr;
    uniform float uMouseDown;
    uniform float uBrushSize;
    uniform float uBrushStrength;
    uniform float uRestore;
    uniform float uSmear;
    uniform float uDt;
    varying vec2 vUv;

    // Distance from p to segment a→b, returning (perpendicular, along, t)
    // where perpendicular is the orthogonal distance from the segment line,
    // along is how far off the segment endpoints p projects to (0 inside),
    // and t is the projection parameter in [0,1]. This gives us anisotropic
    // brush geometry — wide across the stroke, tight along its length.
    vec3 segDist(vec2 p, vec2 a, vec2 b) {
      vec2 ab = b - a;
      float len2 = max(dot(ab, ab), 1e-10);
      float t = dot(p - a, ab) / len2;
      vec2 axis = ab / sqrt(len2);
      vec2 perp = vec2(-axis.y, axis.x);
      vec2 rel  = p - a;
      float along = dot(rel, axis);
      float orth  = abs(dot(rel, perp));
      float segLen = sqrt(len2);
      // Distance beyond the endpoints (0 inside [a,b])
      float beyond = max(max(-along, along - segLen), 0.0);
      return vec3(orth, beyond, clamp(t, 0.0, 1.0));
    }

    // Simple value noise for brush streaks
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p){
      vec2 i = floor(p); vec2 f = fract(p);
      vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(hash(i),             hash(i + vec2(1,0)), u.x),
                 mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
    }

    void main() {
      vec2 uv = vUv;

      // --- Stroke segment ---
      vec2 stroke = uMouseCurr - uMousePrev;
      float strokeLen = length(stroke);

      // If the mouse hasn't moved this frame, disable the brush entirely.
      // A zero-length segment would otherwise trigger a fallback axis that
      // fires a one-frame strobe in the wrong direction — which is the
      // flicker the user is seeing while painting.
      float moving = step(1e-5, strokeLen);

      vec2 axis = strokeLen > 1e-6 ? stroke / strokeLen : vec2(1.0, 0.0);
      vec2 perpDir = vec2(-axis.y, axis.x);

      vec3 seg = segDist(uv, uMousePrev, uMouseCurr);
      float orth = seg.x;
      float beyond = seg.y;
      float tAlong = seg.z;

      // --- Anisotropic Gaussian brush ---
      float halfWidth = max(uBrushSize, 1e-4);
      float bristle = 0.85 + 0.30 * vnoise(uv * 280.0);
      float widthFall = exp(-pow(orth / (halfWidth * bristle), 2.0));
      float endFall   = exp(-pow(beyond / (halfWidth * 1.2), 2.0));
      float nearStroke = widthFall * endFall * moving;

      // --- Advection: pixels get shoved in the stroke direction ---
      vec2 advectedUv = uv - axis * strokeLen * uSmear * nearStroke;
      // Cross-stroke squeeze — pigment on one side of the stroke gets
      // pulled across, like a brush dragging wet paint sideways.
      float perpSign = sign(dot(uv - uMousePrev, perpDir));
      advectedUv -= perpDir * perpSign * halfWidth * 0.15 * nearStroke * uMouseDown;

      vec4 prev = texture2D(uPrev, clamp(advectedUv, 0.001, 0.999));

      // --- Wet-on-wet blur (stronger — oils mix when dragged) ---
      float bleedR = 0.005;
      vec3 mixedCol =
          texture2D(uPrev, clamp(advectedUv + vec2( bleedR,  0.0), 0.001, 0.999)).rgb
        + texture2D(uPrev, clamp(advectedUv + vec2(-bleedR,  0.0), 0.001, 0.999)).rgb
        + texture2D(uPrev, clamp(advectedUv + vec2( 0.0,  bleedR), 0.001, 0.999)).rgb
        + texture2D(uPrev, clamp(advectedUv + vec2( 0.0, -bleedR), 0.001, 0.999)).rgb
        + texture2D(uPrev, clamp(advectedUv + vec2( bleedR, bleedR) * 0.7, 0.001, 0.999)).rgb
        + texture2D(uPrev, clamp(advectedUv + vec2(-bleedR, bleedR) * 0.7, 0.001, 0.999)).rgb
        + texture2D(uPrev, clamp(advectedUv + vec2( bleedR,-bleedR) * 0.7, 0.001, 0.999)).rgb
        + texture2D(uPrev, clamp(advectedUv + vec2(-bleedR,-bleedR) * 0.7, 0.001, 0.999)).rgb;
      mixedCol *= 0.125;
      vec3 prevRgb = mix(prev.rgb, mixedCol, nearStroke * uMouseDown * 0.55);

      // --- Brush deposit with colour pickup ---
      // The brush carries colour from the stroke's START point (where the
      // user's hand was a moment ago). That colour is the CURRENT painted
      // state there, not the pristine source — so successive strokes
      // layer on top of each other and the palette actually mixes.
      // We blend the pickup with the source colour at the stroke center
      // so the brush keeps depositing pigment as well as smearing.
      vec2 pickupUv = uMousePrev;
      vec3 pickupCol = texture2D(uPrev, clamp(pickupUv, 0.001, 0.999)).rgb;

      vec2 strokeCenter = mix(uMousePrev, uMouseCurr, tAlong);
      vec3 srcAtStroke = texture2D(uSrc, clamp(strokeCenter, 0.001, 0.999)).rgb;

      // The brush is loaded 65% with what it picked up + 35% with fresh
      // source pigment. That ratio means re-painting the same area mixes
      // the existing colour instead of resetting it to the original.
      vec3 brushLoad = mix(srcAtStroke, pickupCol, 0.65);

      float brush = uMouseDown * nearStroke * uBrushStrength;
      vec3 deposited = mix(prevRgb, brushLoad, clamp(brush * 0.45, 0.0, 1.0));

      // --- Slow self-healing toward original ---
      // The gravity sag is applied as a UV warp in the DISPLAY pass, not
      // here — that way the image "slumps" as a continuous form instead
      // of the mosaic drip the dirt-based advection produced.
      vec4 src = texture2D(uSrc, uv);
      float dirt = prev.a;
      float healRate = uRestore * (1.0 + 2.5 * dirt);
      vec3 restored = mix(deposited, src.rgb, clamp(healRate, 0.0, 1.0));

      float newDirt = clamp(dirt + brush * 1.0 - healRate * 0.25, 0.0, 1.0);

      gl_FragColor = vec4(restored, newDirt);
    }
  `;

  const updateMat = new THREE.ShaderMaterial({
    uniforms: updateUniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: updateFrag,
    depthTest: false,
    depthWrite: false,
  });
  const updateScene = new THREE.Scene();
  updateScene.add(new THREE.Mesh(quadGeo, updateMat));

  // ---------- Display pass ----------
  const displayUniforms = {
    uPainted:   { value: paintingTex },   // fallback until the RT is primed
    uSrc:       { value: paintingTex },   // untouched original for drip overlay
    uRes:       { value: new THREE.Vector2(initSize.w, initSize.h) },
    uImgAspect: { value: 1.0 },
    uTime:      { value: 0 },
    uFade:      { value: 1.0 },
    uDripTime:  { value: 0 },
  };

  // Now all uniforms exist — load the first gallery image
  loadGalleryImage(0);

  const displayFrag = /* glsl */`
    precision highp float;
    uniform sampler2D uPainted;
    uniform sampler2D uSrc;
    uniform vec2  uRes;
    uniform float uImgAspect;
    uniform float uTime;
    uniform float uFade;
    uniform float uDripTime;
    varying vec2 vUv;

    // Contain fit — keep the image's native aspect, maximise its size
    // inside the frame, and letterbox the remaining axis with black.
    //   landscape frame (16:9) + 1:1 image → image fills the height,
    //                                         black bars on the sides
    //   portrait  frame (9:16) + 1:1 image → image fills the width,
    //                                         black bars top/bottom
    vec2 fitUV(vec2 uv) {
      float canvasAspect = uRes.x / uRes.y;
      vec2 centered = uv - 0.5;
      if (canvasAspect > uImgAspect) {
        centered.x *= canvasAspect / uImgAspect;
      } else {
        centered.y *= uImgAspect / canvasAspect;
      }
      return centered + 0.5;
    }

    // tiny noise so columns sag at slightly different rates (slumpy drip)
    float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
    float n11(float x) {
      float i = floor(x); float f = fract(x);
      float u = f * f * (3.0 - 2.0 * f);
      return mix(h11(i), h11(i + 1.0), u);
    }

    float h12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    // Smooth 2D noise used for paint texture inside drips
    float vn2(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(h12(i),              h12(i + vec2(1.0, 0.0)), u.x),
                 mix(h12(i + vec2(0.0,1)),h12(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm2(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * vn2(p);
        p *= 2.02;
        a *= 0.5;
      }
      return v;
    }

    // Paint drips travelling DOWN the screen. uv here is the fitted image
    // UV where v=1 is the top of the painting and v=0 is the bottom, so
    // a drip grows from (startV) downward toward smaller v.
    //
    // The streak body is thin and slightly wavy (like a real oil run);
    // the head is a fatter bead. Drip colour is sampled from the painting
    // at the origin, darkened and saturated to read as thick wet paint.
    vec4 dripOverlay(vec2 uv) {
      float phase = fract(uDripTime / 30.0);
      vec4 acc = vec4(0.0);

      const int BANDS = 38;
      for (int i = 0; i < BANDS; i++) {
        float fi = float(i);
        float bx = (fi + 0.5) / float(BANDS);
        if (abs(uv.x - bx) > 0.06) continue;

        for (int k = 0; k < 3; k++) {
          float fk = float(k);
          vec2 seed = vec2(fi * 7.1 + fk * 2.3, fk * 13.7 + 0.17);
          float jitterX = (h12(seed) - 0.5) * 0.048;
          float sx = bx + jitterX;

          // Oil-paint drips are FAT — higher base width than water drips
          float width = 0.0040 + 0.0090 * h12(seed + 4.0);

          // Very slight sway — viscous paint barely meanders
          float sway = (h12(seed + 5.0) - 0.5) * 0.006;
          float sxAtY = sx + sway * sin((1.0 - uv.y) * 12.0 + h12(seed + 6.0) * 6.28);

          float dx = uv.x - sxAtY;
          if (abs(dx) > width * 3.5) continue;

          // Oil paint runs SHORT — gravity fights viscosity. Max 30% of
          // image height for the longest drip, most drips 5–15%.
          float maxLen = 0.03 + 0.28 * pow(h12(seed + 1.0), 2.2);
          // SLOW growth — oil paint trickles, doesn't splash.
          float speed  = 0.08 + 0.35 * h12(seed + 7.0);
          float delay  = h12(seed + 2.0) * 0.60;
          float startV = 0.40 + 0.58 * h12(seed + 3.0);

          float localPhase = max(phase - delay, 0.0);
          // Ease-out: drip decelerates as gravity fights viscosity
          float growth = 1.0 - pow(1.0 - min(localPhase * speed / maxLen, 1.0), 1.7);
          float runLen = maxLen * growth;
          if (runLen <= 0.0) continue;

          float headV = startV - runLen;
          if (uv.y > startV || uv.y < headV) continue;

          // --- Paint body mask — oil paint, so the stroke gets FATTER
          // toward the head and ends in a heavy bead. ---
          float tailT = (startV - uv.y) / max(runLen, 1e-4);

          // Width grows along the stroke — thin at the top, fat at the bead.
          // This is the hallmark of viscous paint: the leading drop carries
          // more mass than the trailing ribbon.
          float widthAtY = width * mix(0.55, 1.35, smoothstep(0.0, 1.0, tailT));
          float horiz = exp(-(dx * dx) / (widthAtY * widthAtY));

          // Thin-to-thick taper
          float taper = smoothstep(0.0, 0.40, tailT) * (1.0 - 0.10 * tailT);

          // --- Oil drop head ---
          // A compact tear-shaped bead with a hard silhouette — not a
          // big soft glow. Use a (1 - r^2)^2 falloff so the edge stays
          // crisp until the very rim, like an actual drop of paint.
          float headDist = uv.y - headV;

          // Main bead — smaller than the previous big fuzzy ball.
          float beadR   = width * 1.75;
          float bdx     = dx;
          float bdy     = headDist + beadR * 0.25;
          float beadR2  = (bdx * bdx) / (beadR * beadR * 1.10)
                        + (bdy * bdy) / (beadR * beadR * 0.90);
          // hard-edged disc with a touch of softness at the rim
          float bead = pow(max(1.0 - beadR2, 0.0), 1.2);

          // Tiny sub-drop immediately below the main drop
          float subR = beadR * 0.40;
          float sdx  = dx + (h12(seed + 20.0) - 0.5) * beadR * 0.15;
          float sdy  = headDist + beadR * 0.65;
          float subR2 = (sdx * sdx + sdy * sdy) / (subR * subR);
          float subDrop = pow(max(1.0 - subR2, 0.0), 1.4);

          float headMask = max(bead, subDrop * 0.8);

          float mask = horiz * taper + headMask * 1.4;

          // --- Brush-stroke texture ---
          // A flat brush leaves PARALLEL bristle furrows along the stroke
          // direction. Model them with a high-frequency sin across the
          // width, jittered per-bristle by noise so each bristle has its
          // own density.
          float dxNorm = abs(dx) / max(width, 1e-4);

          // Bristle count determined by brush width — fatter brushes have
          // more bristles. Each bristle is a half-cycle.
          float bristleFreq = 8.0 + h12(seed + 11.0) * 6.0;
          float bristlePhase = (dx / width) * bristleFreq + h12(seed + 12.0) * 6.28;
          float bristle = 0.5 + 0.5 * cos(bristlePhase);

          // Per-bristle opacity jitter from low-freq noise
          float bristleJitter = fbm2(vec2(dx * 260.0 + seed.x * 50.0,
                                          uv.y *  20.0 + seed.y * 11.0));
          bristle *= 0.55 + bristleJitter * 0.55;
          // Bristles fade near the edge so the stroke feathers out
          bristle = mix(bristle, 1.0, 1.0 - smoothstep(0.35, 1.05, dxNorm));

          // Ragged edge (serrated, dry-brush feel)
          float ragged = fbm2(vec2(uv.y * 90.0 + seed.x * 20.0, seed.y * 5.0));
          float edgeRoughen = smoothstep(0.0, 1.0, dxNorm + (ragged - 0.5) * 0.30);
          float edgeShadow = 1.0 - smoothstep(0.55, 1.15, edgeRoughen) * 0.55;

          // Wet gloss highlight, slightly off-centre so it reads 3D
          float glossDx = (dx - (h12(seed + 15.0) - 0.5) * width * 0.4) / max(width, 1e-4);
          float gloss = exp(-glossDx * glossDx * 4.0) * 0.28;

          // Vertical flow streaks — bristle furrows elongate down the drip
          float grain = fbm2(vec2(dx * 600.0 + seed.x * 13.0, uv.y * 120.0));
          grain = 0.80 + grain * 0.40;

          // Large blotchy pigment density variation along length
          float blotch = fbm2(vec2(sx * 38.0 + seed.y * 11.0, uv.y * 18.0));
          blotch = 0.72 + blotch * 0.55;

          // Width wobble — not a perfect tube
          float wobble = fbm2(vec2(uv.y * 32.0, seed.x * 9.0));
          mask *= 0.78 + wobble * 0.44;

          // --- Bead thick-paint shading ---
          // Instead of a plastic sphere, treat the bead like a wad of wet
          // pigment: mostly flat with a sharp rim-shadow and a small
          // off-centre glint. Surface is broken up by high-frequency
          // noise so it reads as oil, not a rendered ball.
          float headWeight = clamp(headMask * 1.6, 0.0, 1.0);

          // Normalised bead coords
          float bnx = bdx / beadR;
          float bny = bdy / beadR;
          float bnr = sqrt(bnx * bnx + bny * bny);

          // High-frequency chunk noise — the "brushstroke in a puddle" look
          float beadChunks = fbm2(vec2(bdx * 650.0 + seed.x * 51.0,
                                       bdy * 650.0 + seed.y * 23.0));
          float beadCoarse = fbm2(vec2(bdx * 180.0 + seed.y * 11.0,
                                       bdy * 180.0 + seed.x * 17.0));

          // Rim shadow — the outer 20 % of the drop is noticeably darker,
          // like the meniscus of a paint blob
          float rimShadow = smoothstep(0.55, 1.0, bnr);

          // Tiny offset glint (not a full sphere highlight)
          vec2 glintCenter = vec2(-0.35, -0.40);
          float glintDist = length(vec2(bnx, bny) - glintCenter);
          float glint = exp(-glintDist * glintDist * 14.0) * 0.35;
          // Gate the glint so it only shows inside the bead
          glint *= step(bnr, 0.85);

          float beadShade = 0.85
                          + 0.18 * (beadCoarse - 0.5)
                          + 0.08 * (beadChunks - 0.5)
                          - 0.55 * rimShadow;
          beadShade = clamp(beadShade, 0.20, 1.05);

          // --- Colour sampled at origin ---
          vec3 c = texture2D(uSrc, clamp(vec2(sx, startV), 0.001, 0.999)).rgb;
          float lum = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(lum), c, 1.40);

          // Body colour (ribbon)
          vec3 body = c * 0.62 * edgeShadow * grain * blotch * bristle;
          body += gloss * vec3(0.95, 0.88, 0.78) * edgeShadow;

          // Bead colour — thick pigment with noise-driven shading.
          // Darker than body so the drop reads as a heavier mass of paint.
          vec3 beadCol = c * 0.55 * beadShade;
          beadCol += glint * vec3(0.85, 0.80, 0.70);

          vec3 finalCol = mix(body, beadCol, headWeight);

          acc.rgb += finalCol * mask;
          acc.a   += mask;
        }
      }

      if (acc.a > 0.001) acc.rgb /= acc.a;
      acc.a = clamp(acc.a, 0.0, 1.0);
      return acc;
    }

    // Blurred background sample for the letterbox margin
    vec3 blurredBg(vec2 p) {
      p = clamp(p, vec2(0.02), vec2(0.98));
      float r = 0.035;
      vec3 s = vec3(0.0);
      s += texture2D(uSrc, p).rgb;
      s += texture2D(uSrc, p + vec2( r, 0.0)).rgb;
      s += texture2D(uSrc, p + vec2(-r, 0.0)).rgb;
      s += texture2D(uSrc, p + vec2(0.0,  r)).rgb;
      s += texture2D(uSrc, p + vec2(0.0, -r)).rgb;
      s += texture2D(uSrc, p + vec2( r,  r) * 0.7).rgb;
      s += texture2D(uSrc, p + vec2(-r,  r) * 0.7).rgb;
      s += texture2D(uSrc, p + vec2( r, -r) * 0.7).rgb;
      s += texture2D(uSrc, p + vec2(-r, -r) * 0.7).rgb;
      return s / 9.0;
    }

    void main() {
      vec2 uvFit = fitUV(vUv);

      vec3 col;
      if (uvFit.x >= 0.0 && uvFit.x <= 1.0 && uvFit.y >= 0.0 && uvFit.y <= 1.0) {
        vec4 painted = texture2D(uPainted, uvFit);
        col = painted.rgb;
        // Dirt (alpha) tracks how much this pixel has been brushed.
        // Where the user has painted, the drip overlay fades out so the
        // brush strokes visually disrupt the drips — exactly as if you
        // smeared through wet paint that was running down the canvas.
        float dirt = painted.a;
        vec4 drip = dripOverlay(uvFit);
        float dripVisible = drip.a * (1.0 - clamp(dirt * 3.0, 0.0, 1.0));
        col = mix(col, drip.rgb, dripVisible);
        vec2 vig = uvFit - 0.5;
        float vigD = length(vig);
        float breath = 0.88 + 0.06 * sin(uTime * 0.4);
        col *= mix(1.0, breath, smoothstep(0.3, 0.75, vigD));
      } else {
        vec2 bgUv = clamp(uvFit, vec2(0.0), vec2(1.0));
        vec3 bg = blurredBg(bgUv);
        float bgLum = dot(bg, vec3(0.299, 0.587, 0.114));
        bg = mix(vec3(bgLum), bg, 0.55);
        col = bg * 0.35;
      }

      gl_FragColor = vec4(col * uFade, 1.0);
    }
  `;

  const displayMat = new THREE.ShaderMaterial({
    uniforms: displayUniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: displayFrag,
  });
  displayScene.add(new THREE.Mesh(quadGeo, displayMat));

  // ---------- Mouse → source-UV projection ----------
  // We need the brush coords in the painting's own UV space so brushstroke
  // geometry matches the visible image regardless of canvas/image aspect.
  let mousePrev   = new THREE.Vector2(-10, -10);  // source-UV space
  let mouseCurr   = new THREE.Vector2(-10, -10);
  let mouseInside = false;
  let mousePressed = false;
  let strokeActiveFrames = 0; // >0 means we have a fresh move to consume

  function clientToSourceUV(clientX, clientY) {
    const r = box.getBoundingClientRect();
    const cx = (clientX - r.left) / r.width;
    const cy = 1.0 - (clientY - r.top) / r.height;
    const canvasAspect = r.width / r.height;
    const imgAspect = displayUniforms.uImgAspect.value || 1.0;
    // Inverse of the contain-fit in the display shader.
    let u, v;
    if (canvasAspect > imgAspect) {
      u = (cx - 0.5) * (canvasAspect / imgAspect) + 0.5;
      v = cy;
    } else {
      u = cx;
      v = (cy - 0.5) * (imgAspect / canvasAspect) + 0.5;
    }
    return { u, v };
  }

  window.addEventListener('mousemove', (e) => {
    const r = box.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top  && e.clientY <= r.bottom;
    if (!inside) { mouseInside = false; return; }
    const uv = clientToSourceUV(e.clientX, e.clientY);
    if (!mouseInside) {
      // Entering the box — start a fresh stroke so the first frame
      // doesn't splash a huge segment from wherever the cursor used to be.
      mousePrev.set(uv.u, uv.v);
      mouseCurr.set(uv.u, uv.v);
      mouseInside = true;
      return;
    }
    mousePrev.copy(mouseCurr);
    mouseCurr.set(uv.u, uv.v);
    strokeActiveFrames = 2;
  });
  box.addEventListener('mouseleave', () => {
    mouseInside = false;
    mousePressed = false;
    // Wipe the stroke endpoints so re-entry doesn't replay an enormous
    // segment from wherever the cursor last left — that was one of the
    // "painting flashes" the user kept seeing.
    mousePrev.set(-10, -10);
    mouseCurr.set(-10, -10);
    strokeActiveFrames = 0;
  });
  box.addEventListener('mousedown', (e) => {
    const uv = clientToSourceUV(e.clientX, e.clientY);
    mousePrev.set(uv.u, uv.v);
    mouseCurr.set(uv.u, uv.v);
    mousePressed = true;
  });
  window.addEventListener('mouseup', () => { mousePressed = false; });

  // touch
  box.addEventListener('touchstart', (e) => {
    if (!e.touches.length) return;
    const t = e.touches[0];
    const uv = clientToSourceUV(t.clientX, t.clientY);
    mousePrev.set(uv.u, uv.v);
    mouseCurr.set(uv.u, uv.v);
    mousePressed = true;
    mouseInside = true;
  }, { passive: true });
  box.addEventListener('touchmove', (e) => {
    if (!e.touches.length) return;
    const t = e.touches[0];
    const uv = clientToSourceUV(t.clientX, t.clientY);
    mousePrev.copy(mouseCurr);
    mouseCurr.set(uv.u, uv.v);
    strokeActiveFrames = 2;
  }, { passive: true });
  box.addEventListener('touchend', () => { mousePressed = false; });

  // Debounced resize — prevents the flash caused by rapid resize events
  // (e.g. rotating the phone). We wait until resize events stop for 150ms,
  // then apply the new size and re-seed the painted RT so the image is
  // clean at the new aspect.
  let resizeTimer = null;
  function resize() {
    const s = getBoxSize();
    if (s.w < 2 || s.h < 2) return;
    renderer.setSize(s.w, s.h, false);
    displayUniforms.uRes.value.set(s.w, s.h);
    if (paintingReady) {
      seedPaintedRTs();
      displayUniforms.uPainted.value = paintedA.texture;
    }
  }
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  // ---------- Step In ----------
  let transitioning = false;
  function stepIn() {
    if (transitioning) return;
    transitioning = true;
    document.body.classList.add('transitioning');
    const start = performance.now();
    const dur = 1100;
    function tick() {
      const t = (performance.now() - start) / dur;
      displayUniforms.uFade.value = Math.max(0.0, 1.0 - t * 1.25);
      if (t < 1.0) requestAnimationFrame(tick);
      else window.location.href = 'index.html';
    }
    requestAnimationFrame(tick);
  }
  if (enterBtn) enterBtn.addEventListener('click', stepIn);

  // ---------- Main loop ----------
  const clock = new THREE.Clock();
  function animate() {
    const dt = Math.min(clock.getDelta(), 0.033);
    displayUniforms.uTime.value += dt;
    displayUniforms.uDripTime.value += dt;

    if (paintingReady) {
      // Display always shows the painting texture directly. The update
      // pass (brush smear + heal) only runs when there is an active
      // stroke — idle frames skip it entirely to prevent any feedback
      // loop from degrading the image over time (which was causing the
      // persistent flicker the user kept seeing).
      const haveStroke = strokeActiveFrames > 0 && mouseInside;

      if (haveStroke) {
        updateUniforms.uPrev.value = paintedA.texture;
        updateUniforms.uMousePrev.value.copy(mousePrev);
        updateUniforms.uMouseCurr.value.copy(mouseCurr);
        const pressActive = mousePressed ? 1.0 : 0.0;
        updateUniforms.uMouseDown.value = 0.35 + 0.65 * pressActive;
        updateUniforms.uCanvasAspect.value = displayUniforms.uRes.value.x / Math.max(displayUniforms.uRes.value.y, 1);
        updateUniforms.uImgAspect.value = displayUniforms.uImgAspect.value;
        updateUniforms.uDt.value = dt;

        renderer.setRenderTarget(paintedB);
        renderer.render(updateScene, displayCamera);
        renderer.setRenderTarget(null);

        const tmp = paintedA; paintedA = paintedB; paintedB = tmp;
        displayUniforms.uPainted.value = paintedA.texture;

        strokeActiveFrames--;
        mousePrev.copy(mouseCurr);
      }
      // When idle, displayUniforms.uPainted already points at the last
      // painted state (or the original if never brushed). No update pass
      // runs, so no chance of feedback-loop degradation.
    }

    renderer.render(displayScene, displayCamera);
    requestAnimationFrame(animate);
  }
  animate();
})();
