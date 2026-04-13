#!/usr/bin/env node
// Fetches the current total pageview count from the mapmyvisitors widget
// backend and rewrites the hardcoded number in home.html.
//
// The widget endpoint is not a public / documented API, so this script is
// defensive: if anything goes wrong (network error, format change, parse
// miss) it prints a warning and exits 0 without touching home.html, which
// keeps the GitHub Actions workflow green and the old number in place.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const HOME_HTML = join(REPO_ROOT, 'home.html');

const WIDGET_URL =
  'https://mapmyvisitors.com/widget_call_home.js' +
  '?cl=1a3550&w=a&t=tt' +
  '&d=PhTVc0EN9UJ-ZZX2mFvu3Dju_S7JehGQbZrOF2gfBOo' +
  '&co=050608&ct=4a7090&cmo=9bcae8&cmn=c1ddf0';

// Matches the mapmyvisitors rendering line, e.g.
//   .html('7,639 Total Pageviews');
// Capture group 1 = the formatted number (digits + commas).
const PAGEVIEW_RE = /['"]([\d,]+)\s+Total\s+Pageviews['"]/;

// Matches the corresponding span in home.html:
//   <span class="meta-value">7,581</span> &nbsp;Pageviews
const HOME_SPAN_RE =
  /(<span class="meta-value">)([\d,]+)(<\/span>\s*(?:&nbsp;|\s)*Pageviews)/;

function log(msg) { console.log(`[update_pageviews] ${msg}`); }
function warn(msg) { console.warn(`[update_pageviews] WARN: ${msg}`); }

async function fetchWidget() {
  const res = await fetch(WIDGET_URL, {
    headers: {
      // The endpoint sometimes rejects requests without a browser-ish UA.
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://kwonjoon.info/',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

function parseCount(body) {
  const m = body.match(PAGEVIEW_RE);
  if (!m) return null;
  const raw = m[1];
  const n = parseInt(raw.replace(/,/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { raw, n };
}

function formatWithCommas(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function main() {
  let body;
  try {
    body = await fetchWidget();
  } catch (err) {
    warn(`fetch failed: ${err.message}`);
    return;
  }

  const parsed = parseCount(body);
  if (!parsed) {
    warn('could not find "N Total Pageviews" in widget response; endpoint format may have changed');
    return;
  }
  log(`fetched pageview count: ${parsed.raw} (${parsed.n})`);

  const html = readFileSync(HOME_HTML, 'utf8');
  const match = html.match(HOME_SPAN_RE);
  if (!match) {
    warn('could not find <span class="meta-value">...</span> Pageviews in home.html');
    return;
  }
  const current = match[2];
  const currentNum = parseInt(current.replace(/,/g, ''), 10);
  log(`current value in home.html: ${current} (${currentNum})`);

  if (current === parsed.raw || currentNum === parsed.n) {
    log('no change — home.html already up to date');
    return;
  }

  // Only allow the number to go up. If the remote value is suddenly lower
  // than what we have (widget glitch, cache reset, parser confusion),
  // refuse to write so we don't accidentally clobber a good value.
  if (parsed.n < currentNum) {
    warn(`remote count (${parsed.n}) is lower than current (${currentNum}) — refusing to overwrite`);
    return;
  }

  const formatted = formatWithCommas(parsed.n);
  const nextHtml = html.replace(
    HOME_SPAN_RE,
    (_, open, _old, close) => `${open}${formatted}${close}`
  );
  writeFileSync(HOME_HTML, nextHtml);
  log(`updated home.html: ${current} -> ${formatted}`);
}

main().catch((err) => {
  warn(`unexpected error: ${err.stack || err.message}`);
  // Still exit 0 so the workflow doesn't fail on transient issues.
  process.exit(0);
});
