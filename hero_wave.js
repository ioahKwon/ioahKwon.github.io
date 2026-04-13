(function () {
  const container = document.getElementById('hero-wave');
  if (!container) return;
  if (typeof THREE === 'undefined') {
    console.warn('[hero_wave] THREE.js not loaded');
    return;
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x041228, 0.045);

  const width  = container.clientWidth;
  const height = container.clientHeight;

  // Lower, closer camera — looks across the wave from the side for a clear crest line
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 200);
  camera.position.set(0, 1.05, 5.6);
  camera.lookAt(0, 0.25, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x041228, 1);
  container.appendChild(renderer.domElement);

  // --- Raycaster for mouse→world projection onto the water plane (y=0) ---
  const raycaster = new THREE.Raycaster();
  const mouseNdc  = new THREE.Vector2(-10, -10);
  const mouseWorld = new THREE.Vector3(0, 0, -100);
  const planeY0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // --- Tight circular sprite: crisp core, minimal halo (prevents blob look) ---
  function makeSprite() {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.00, 'rgba(255,255,255,1)');
    g.addColorStop(0.30, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.60, 'rgba(200,235,255,0.35)');
    g.addColorStop(1.00, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  }
  const spriteTex = makeSprite();

  // --- Point cloud: denser, grid-based (jittered) for a true surface-scan look ---
  const gridX = 360;
  const gridZ = 220;
  const COUNT = gridX * gridZ;
  const areaW = 10.0;
  const areaD = 5.5;

  const positions = new Float32Array(COUNT * 3);
  const aSeed     = new Float32Array(COUNT);
  const aScale    = new Float32Array(COUNT);
  let k = 0;
  for (let iz = 0; iz < gridZ; iz++) {
    for (let ix = 0; ix < gridX; ix++) {
      const u = ix / (gridX - 1);
      const v = iz / (gridZ - 1);
      // jittered grid: keeps even coverage but avoids visible rows
      const jx = (Math.random() - 0.5) / gridX * areaW * 1.4;
      const jz = (Math.random() - 0.5) / gridZ * areaD * 1.4;
      positions[k * 3 + 0] = (u - 0.5) * areaW + jx;
      positions[k * 3 + 1] = 0;
      positions[k * 3 + 2] = (v - 0.5) * areaD + jz;
      aSeed[k]  = Math.random() * 1000.0;
      aScale[k] = 0.75 + Math.random() * 0.6;
      k++;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('aSeed',    new THREE.BufferAttribute(aSeed, 1));
  geom.setAttribute('aScale',   new THREE.BufferAttribute(aScale, 1));

  const uniforms = {
    uTime:       { value: 0 },
    uMouse:      { value: new THREE.Vector3(0, 0, -100) },
    uMouseOn:    { value: 0 },
    uRipple:     { value: new THREE.Vector3(0, 0, -10) }, // x,z,age
    uSprite:     { value: spriteTex },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uSize:       { value: 9.0 },
    uColorDeep:  { value: new THREE.Color(0x1a5a9e) },
    uColorMid:   { value: new THREE.Color(0x5ad0ff) },
    uColorCrest: { value: new THREE.Color(0xf4fbff) },
  };

  const vert = /* glsl */`
    uniform float uTime;
    uniform vec3  uMouse;
    uniform float uMouseOn;
    uniform vec3  uRipple;
    uniform float uPixelRatio;
    uniform float uSize;

    attribute float aSeed;
    attribute float aScale;

    varying float vHeight;
    varying float vDist;
    varying float vSeed;

    // --- Gerstner contribution ---
    void gerstner(vec2 p, vec2 dir, float A, float w, float phi, float Q,
                  inout vec3 offset) {
      float theta = dot(dir, p) * w + uTime * phi;
      float c = cos(theta);
      float s = sin(theta);
      offset.x += Q * A * dir.x * c;
      offset.z += Q * A * dir.y * c;
      offset.y += A * s;
    }

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float vnoise(vec2 p){
      vec2 i=floor(p), f=fract(p);
      vec2 u=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
    }

    void main() {
      vec2 p = position.xz;
      vec3 offset = vec3(0.0);

      // One dominant low-freq swell + smaller ripples layered on top
      gerstner(p, normalize(vec2( 1.0,  0.15)), 0.28, 0.55, 0.80, 0.75, offset);
      gerstner(p, normalize(vec2( 0.85,-0.35)), 0.14, 0.95, 1.05, 0.55, offset);
      gerstner(p, normalize(vec2(-0.55, 0.90)), 0.065, 1.70, 1.50, 0.45, offset);
      gerstner(p, normalize(vec2( 0.35, 0.85)), 0.040, 2.60, 1.95, 0.40, offset);
      gerstner(p, normalize(vec2(-0.95,-0.15)), 0.022, 3.80, 2.50, 0.35, offset);

      // fine chop
      offset.y += (vnoise(p * 2.8 + vec2(uTime * 0.35, -uTime * 0.25)) - 0.5) * 0.035;

      // --- Mouse repulsion in XZ, plus a lift ---
      vec3 worldBase = vec3(p.x + offset.x, offset.y, p.y + offset.z);
      vec2 toMouse = worldBase.xz - uMouse.xz;
      float md = length(toMouse);
      float mInfluence = uMouseOn * exp(-md * md * 0.9);
      vec2 push = (md > 0.0001 ? toMouse / md : vec2(0.0)) * mInfluence * 0.35;
      worldBase.x += push.x;
      worldBase.z += push.y;
      worldBase.y += mInfluence * 0.55;  // lift under cursor

      // --- Click ripple (ring displacement in y) ---
      if (uRipple.z >= 0.0) {
        vec2 rp = uRipple.xy;
        float rd = length(worldBase.xz - rp);
        float age = uRipple.z;
        float ring = sin(rd * 12.0 - age * 10.0) * exp(-rd * 1.8) * exp(-age * 1.4);
        worldBase.y += ring * 0.45;
      }

      // per-point vertical jitter so cloud isn't flat at trough
      worldBase.y += (fract(sin(aSeed) * 43758.5) - 0.5) * 0.03;

      vHeight = worldBase.y;
      vSeed = aSeed;

      vec4 mv = modelViewMatrix * vec4(worldBase, 1.0);
      vDist = -mv.z;

      gl_Position = projectionMatrix * mv;

      // Size: perspective falloff + per-point scale + crest boost
      float crestBoost = 1.0 + smoothstep(0.05, 0.22, worldBase.y) * 1.2;
      float size = uSize * aScale * crestBoost * uPixelRatio / max(vDist, 0.1);
      gl_PointSize = clamp(size, 1.0, 80.0);
    }
  `;

  const frag = /* glsl */`
    uniform sampler2D uSprite;
    uniform vec3 uColorDeep;
    uniform vec3 uColorMid;
    uniform vec3 uColorCrest;

    varying float vHeight;
    varying float vDist;
    varying float vSeed;

    void main() {
      vec4 tex = texture2D(uSprite, gl_PointCoord);
      if (tex.a < 0.02) discard;

      // Color by height: deep→mid→crest (wider crest range for brighter look)
      float t1 = smoothstep(-0.25, 0.00, vHeight);
      float t2 = smoothstep( 0.02, 0.18, vHeight);
      vec3 col = mix(uColorDeep, uColorMid, t1);
      col = mix(col, uColorCrest, t2);

      // Subtle inner glow boost at crests
      col += smoothstep(0.10, 0.25, vHeight) * vec3(0.12, 0.15, 0.18);

      // Slight per-point hue variance from seed
      col += (fract(sin(vSeed) * 91.37) - 0.5) * 0.06;

      // Depth fade (softer fog for brighter overall feel)
      float fog = exp(-vDist * 0.055);

      gl_FragColor = vec4(col, tex.a * fog);
    }
  `;

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const points = new THREE.Points(geom, mat);
  scene.add(points);

  // --- Interaction ---
  let mouseInside = false;

  container.addEventListener('mousemove', (e) => {
    const rect = container.getBoundingClientRect();
    mouseNdc.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    mouseNdc.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    mouseInside = true;
  });
  container.addEventListener('mouseleave', () => { mouseInside = false; });
  container.addEventListener('click', () => {
    if (mouseWorld.z > -50) {
      uniforms.uRipple.value.set(mouseWorld.x, mouseWorld.z, 0.0);
    }
  });

  let scrollDamp = 1.0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY || 0;
    scrollDamp = Math.max(0.35, 1.0 - y / 700);
  }, { passive: true });

  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
  });

  const clock = new THREE.Clock();
  function animate() {
    const dt = Math.min(clock.getDelta(), 0.05);
    uniforms.uTime.value += dt * scrollDamp;

    // Project mouse NDC → world on plane y=0
    if (mouseInside) {
      raycaster.setFromCamera(mouseNdc, camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(planeY0, hit)) {
        mouseWorld.copy(hit);
      }
      uniforms.uMouse.value.copy(mouseWorld);
      uniforms.uMouseOn.value += (1.0 - uniforms.uMouseOn.value) * 0.08;
    } else {
      uniforms.uMouseOn.value += (0.0 - uniforms.uMouseOn.value) * 0.06;
    }

    // Click ripple age
    if (uniforms.uRipple.value.z >= 0.0) {
      uniforms.uRipple.value.z += dt;
      if (uniforms.uRipple.value.z > 3.2) uniforms.uRipple.value.z = -10.0;
    }

    // Subtle drift — keeps the side-on framing
    const tt = uniforms.uTime.value;
    camera.position.x = Math.sin(tt * 0.10) * 0.45;
    camera.position.y = 1.05 + Math.sin(tt * 0.16) * 0.08;
    camera.position.z = 5.6 + Math.cos(tt * 0.08) * 0.20;
    camera.lookAt(0, 0.25, 0);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
})();
