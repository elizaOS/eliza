var Ys = Object.defineProperty;
var Gs = (n, t, e) =>
  t in n ? Ys(n, t, { enumerable: !0, configurable: !0, writable: !0, value: e }) : (n[t] = e);
var v = (n, t, e) => Gs(n, typeof t != 'symbol' ? t + '' : t, e);
function Vs(n, t) {
  const e = new Array(t.length).fill(0);
  return new Array(t.length).fill(0).map((s, r) => (i, a) => {
    (e[r] = (i / a) * t[r] * 1e3),
      n(
        e.reduce((c, l) => c + l, 0),
        1e3
      );
  });
}
const Ln = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function Zs(n) {
  return n.replace(/[&<>"']/gu, (t) => Ln[t]);
}
function Ks(n) {
  return n.replace(/[&<]/gu, (t) => Ln[t]);
}
function vt(n, t, e) {
  return n.find((s, r) => {
    if (r === n.length - 1) return !0;
    const i = n[r + 1];
    return Math.abs(t(s) - e) < Math.abs(t(i) - e);
  });
}
function vn(n) {
  return Array.isArray(n) && typeof n[0] == 'string';
}
function Xs(n) {
  return Array.isArray(n) && Array.isArray(n[0]);
}
class $s {
  constructor(t, e, s, r, i) {
    v(this, '_htmlCache');
    v(this, '_snapshots');
    v(this, '_index');
    v(this, 'snapshotName');
    v(this, '_resources');
    v(this, '_snapshot');
    v(this, '_callId');
    v(this, '_screencastFrames');
    (this._htmlCache = t),
      (this._resources = e),
      (this._snapshots = s),
      (this._index = i),
      (this._snapshot = s[i]),
      (this._callId = s[i].callId),
      (this._screencastFrames = r),
      (this.snapshotName = s[i].snapshotName);
  }
  snapshot() {
    return this._snapshots[this._index];
  }
  viewport() {
    return this._snapshots[this._index].viewport;
  }
  closestScreenshot() {
    var r;
    const { wallTime: t, timestamp: e } = this.snapshot(),
      s =
        t && (r = this._screencastFrames[0]) != null && r.frameSwapWallTime
          ? vt(this._screencastFrames, (i) => i.frameSwapWallTime, t)
          : vt(this._screencastFrames, (i) => i.timestamp, e);
    return s == null ? void 0 : s.sha1;
  }
  render() {
    const t = [],
      e = (i, a, c, l) => {
        if (typeof i == 'string') {
          c === 'STYLE' || c === 'style' ? t.push(tr(i)) : t.push(Ks(i));
          return;
        }
        if (Xs(i)) {
          const _ = a - i[0][0];
          if (_ >= 0 && _ <= a) {
            const f = Qs(this._snapshots[_]),
              b = i[0][1];
            if (b >= 0 && b < f.length) return e(f[b], _, c, l);
          }
        } else if (vn(i)) {
          const [_, f, ...b] = i,
            h = _ === 'NOSCRIPT' ? 'X-NOSCRIPT' : _,
            S = Object.entries(f || {});
          t.push('<', h);
          const C = '__playwright_current_src__',
            u = h === 'IFRAME' || h === 'FRAME',
            o = h === 'A',
            d = h === 'IMG',
            y = d && S.some((w) => w[0] === C),
            g =
              h === 'SOURCE' && c === 'PICTURE' && (l == null ? void 0 : l.some((w) => w[0] === C));
          for (const [w, E] of S) {
            let p = w;
            u && w.toLowerCase() === 'src' && (p = '__playwright_src__'),
              d && w === C && (p = 'src'),
              ['src', 'srcset'].includes(w.toLowerCase()) && (y || g) && (p = '_' + p);
            let R = E;
            o && w.toLowerCase() === 'href'
              ? (R = 'link://' + E)
              : (w.toLowerCase() === 'href' || w.toLowerCase() === 'src' || w === C) && (R = rt(E)),
              t.push(' ', p, '="', Zs(R), '"');
          }
          t.push('>');
          for (const w of b) e(w, a, h, S);
          Js.has(h) || t.push('</', h, '>');
          return;
        } else return;
      },
      s = this._snapshot;
    return {
      html: this._htmlCache.getOrCompute(this, () => {
        e(s.html, this._index, void 0, void 0);
        const a =
          (s.doctype ? `<!DOCTYPE ${s.doctype}>` : '') +
          [
            '<style>*,*::before,*::after { visibility: hidden }</style>',
            `<script>${zs(this.viewport(), this._callId, this.snapshotName)}<\/script>`,
          ].join('') +
          t.join('');
        return { value: a, size: a.length };
      }),
      pageId: s.pageId,
      frameId: s.frameId,
      index: this._index,
    };
  }
  resourceByUrl(t, e) {
    const s = this._snapshot;
    let r, i;
    for (const c of this._resources) {
      if (typeof c._monotonicTime == 'number' && c._monotonicTime >= s.timestamp) break;
      c.response.status !== 304 &&
        c.request.url === t &&
        c.request.method === e &&
        (c._frameref === s.frameId ? (r = c) : (i = c));
    }
    let a = r ?? i;
    if (a && e.toUpperCase() === 'GET') {
      for (const c of s.resourceOverrides)
        if (t === c.url && c.sha1) {
          a = {
            ...a,
            response: { ...a.response, content: { ...a.response.content, _sha1: c.sha1 } },
          };
          break;
        }
    }
    return a;
  }
}
const Js = new Set([
  'AREA',
  'BASE',
  'BR',
  'COL',
  'COMMAND',
  'EMBED',
  'HR',
  'IMG',
  'INPUT',
  'KEYGEN',
  'LINK',
  'MENUITEM',
  'META',
  'PARAM',
  'SOURCE',
  'TRACK',
  'WBR',
]);
function Qs(n) {
  if (!n._nodes) {
    const t = [],
      e = (s) => {
        if (typeof s == 'string') t.push(s);
        else if (vn(s)) {
          const [, , ...r] = s;
          for (const i of r) e(i);
          t.push(s);
        }
      };
    e(n.html), (n._nodes = t);
  }
  return n._nodes;
}
function zs(n, ...t) {
  function e(s, r, ...i) {
    const a = new URLSearchParams(location.search),
      c = a.has('shouldPopulateCanvasFromScreenshot'),
      l = a.has('isUnderTest'),
      _ = { viewport: r, frames: new WeakMap() };
    window.__playwright_frame_bounding_rects__ = _;
    const f =
        'Recorded click position in absolute coordinates did not match the center of the clicked element. This is likely due to a difference between the test runner and the trace viewer operating systems.',
      b = [],
      h = [],
      S = [],
      C = [];
    let u = window;
    for (; u !== u.parent && !u.location.pathname.match(/\/page@[a-z0-9]+$/); ) u = u.parent;
    const o = (g) => {
        for (const w of g.querySelectorAll('[__playwright_scroll_top_]')) b.push(w);
        for (const w of g.querySelectorAll('[__playwright_scroll_left_]')) h.push(w);
        for (const w of g.querySelectorAll('[__playwright_value_]')) {
          const E = w;
          E.type !== 'file' && (E.value = E.getAttribute('__playwright_value_')),
            w.removeAttribute('__playwright_value_');
        }
        for (const w of g.querySelectorAll('[__playwright_checked_]'))
          (w.checked = w.getAttribute('__playwright_checked_') === 'true'),
            w.removeAttribute('__playwright_checked_');
        for (const w of g.querySelectorAll('[__playwright_selected_]'))
          (w.selected = w.getAttribute('__playwright_selected_') === 'true'),
            w.removeAttribute('__playwright_selected_');
        for (const w of g.querySelectorAll('[__playwright_popover_open_]')) {
          try {
            w.showPopover();
          } catch {}
          w.removeAttribute('__playwright_popover_open_');
        }
        for (const w of i)
          for (const E of g.querySelectorAll(`[__playwright_target__="${w}"]`)) {
            const p = E.style;
            (p.outline = '2px solid #006ab1'), (p.backgroundColor = '#6fa8dc7f'), S.push(E);
          }
        for (const w of g.querySelectorAll('iframe, frame')) {
          const E = w.getAttribute('__playwright_bounding_rect__');
          w.removeAttribute('__playwright_bounding_rect__');
          const p = E ? JSON.parse(E) : void 0;
          p && _.frames.set(w, { boundingRect: p, scrollLeft: 0, scrollTop: 0 });
          const R = w.getAttribute('__playwright_src__');
          if (!R) w.setAttribute('src', 'data:text/html,<body style="background: #ddd"></body>');
          else {
            const T = new URL(s(window.location.href)),
              A = T.pathname.lastIndexOf('/snapshot/');
            A !== -1 && (T.pathname = T.pathname.substring(0, A + 1)),
              (T.pathname += R.substring(1)),
              w.setAttribute('src', T.toString());
          }
        }
        {
          const w = g.querySelector('body[__playwright_custom_elements__]');
          if (w && window.customElements) {
            const E = (w.getAttribute('__playwright_custom_elements__') || '').split(',');
            for (const p of E) window.customElements.define(p, class extends HTMLElement {});
          }
        }
        for (const w of g.querySelectorAll('template[__playwright_shadow_root_]')) {
          const E = w,
            p = E.parentElement.attachShadow({ mode: 'open' });
          p.appendChild(E.content), E.remove(), o(p);
        }
        if ('adoptedStyleSheets' in g) {
          const w = [...g.adoptedStyleSheets];
          for (const E of g.querySelectorAll('template[__playwright_style_sheet_]')) {
            const p = E,
              R = new CSSStyleSheet();
            R.replaceSync(p.getAttribute('__playwright_style_sheet_')), w.push(R);
          }
          g.adoptedStyleSheets = w;
        }
        C.push(...g.querySelectorAll('canvas'));
      },
      d = () => {
        window.removeEventListener('load', d);
        for (const E of b)
          (E.scrollTop = +E.getAttribute('__playwright_scroll_top_')),
            E.removeAttribute('__playwright_scroll_top_'),
            _.frames.has(E) && (_.frames.get(E).scrollTop = E.scrollTop);
        for (const E of h)
          (E.scrollLeft = +E.getAttribute('__playwright_scroll_left_')),
            E.removeAttribute('__playwright_scroll_left_'),
            _.frames.has(E) && (_.frames.get(E).scrollLeft = E.scrollTop);
        document.styleSheets[0].disabled = !0;
        const g = new URL(window.location.href).searchParams,
          w = window === u;
        if (g.get('pointX') && g.get('pointY')) {
          const E = +g.get('pointX'),
            p = +g.get('pointY'),
            R = g.has('hasInputTarget'),
            T = S.length > 0,
            A = document.documentElement ? [document.documentElement] : [];
          for (const x of T ? S : A) {
            const m = document.createElement('x-pw-pointer');
            if (
              ((m.style.position = 'fixed'),
              (m.style.backgroundColor = '#f44336'),
              (m.style.width = '20px'),
              (m.style.height = '20px'),
              (m.style.borderRadius = '10px'),
              (m.style.margin = '-10px 0 0 -10px'),
              (m.style.zIndex = '2147483646'),
              (m.style.display = 'flex'),
              (m.style.alignItems = 'center'),
              (m.style.justifyContent = 'center'),
              T)
            ) {
              const I = x.getBoundingClientRect(),
                O = I.left + I.width / 2,
                N = I.top + I.height / 2;
              if (
                ((m.style.left = O + 'px'),
                (m.style.top = N + 'px'),
                w && (Math.abs(O - E) >= 10 || Math.abs(N - p) >= 10))
              ) {
                const P = document.createElement('x-pw-pointer-warning');
                (P.textContent = '⚠'),
                  (P.style.fontSize = '19px'),
                  (P.style.color = 'white'),
                  (P.style.marginTop = '-3.5px'),
                  (P.style.userSelect = 'none'),
                  m.appendChild(P),
                  m.setAttribute('title', f);
              }
              document.documentElement.appendChild(m);
            } else
              w &&
                !R &&
                ((m.style.left = E + 'px'),
                (m.style.top = p + 'px'),
                document.documentElement.appendChild(m));
          }
        }
        if (C.length > 0) {
          let E = function (R, T) {
            function A() {
              const x = document.createElement('canvas');
              (x.width = x.width / Math.floor(x.width / 24)),
                (x.height = x.height / Math.floor(x.height / 24));
              const m = x.getContext('2d');
              return (
                (m.fillStyle = 'lightgray'),
                m.fillRect(0, 0, x.width, x.height),
                (m.fillStyle = 'white'),
                m.fillRect(0, 0, x.width / 2, x.height / 2),
                m.fillRect(x.width / 2, x.height / 2, x.width, x.height),
                m.createPattern(x, 'repeat')
              );
            }
            (R.fillStyle = A()), R.fillRect(0, 0, T.width, T.height);
          };
          const p = new Image();
          (p.onload = () => {
            var R;
            for (const T of C) {
              const A = T.getContext('2d'),
                x = T.getAttribute('__playwright_bounding_rect__');
              if ((T.removeAttribute('__playwright_bounding_rect__'), !x)) continue;
              let m;
              try {
                m = JSON.parse(x);
              } catch {
                continue;
              }
              let I = window;
              for (; I !== u; ) {
                const M = I.frameElement;
                I = I.parent;
                const L =
                  (R = I.__playwright_frame_bounding_rects__) == null ? void 0 : R.frames.get(M);
                if (!(L != null && L.boundingRect)) break;
                const Y = L.boundingRect.left - L.scrollLeft,
                  k = L.boundingRect.top - L.scrollTop;
                (m.left += Y), (m.top += k), (m.right += Y), (m.bottom += k);
              }
              const { width: O, height: N } = u.__playwright_frame_bounding_rects__.viewport;
              (m.left = m.left / O),
                (m.top = m.top / N),
                (m.right = m.right / O),
                (m.bottom = m.bottom / N);
              const P = m.right > 1 || m.bottom > 1;
              if (m.left > 1 || m.top > 1) {
                T.title =
                  "Playwright couldn't capture canvas contents because it's located outside the viewport.";
                continue;
              }
              E(A, T),
                c
                  ? (A.drawImage(
                      p,
                      m.left * p.width,
                      m.top * p.height,
                      (m.right - m.left) * p.width,
                      (m.bottom - m.top) * p.height,
                      0,
                      0,
                      T.width,
                      T.height
                    ),
                    P
                      ? (T.title =
                          "Playwright couldn't capture full canvas contents because it's located partially outside the viewport.")
                      : (T.title =
                          'Canvas contents are displayed on a best-effort basis based on viewport screenshots taken during test execution.'))
                  : (T.title = 'Canvas content display is disabled.'),
                l &&
                  console.log(
                    'canvas drawn:',
                    JSON.stringify(
                      [m.left, m.top, m.right - m.left, m.bottom - m.top].map((M) =>
                        Math.floor(M * 100)
                      )
                    )
                  );
            }
          }),
            (p.onerror = () => {
              for (const R of C) {
                const T = R.getContext('2d');
                E(T, R),
                  (R.title =
                    "Playwright couldn't show canvas contents because the screenshot failed to load.");
              }
            }),
            (p.src = location.href.replace('/snapshot', '/closest-screenshot'));
        }
      },
      y = () => o(document);
    window.addEventListener('load', d), window.addEventListener('DOMContentLoaded', y);
  }
  return `
(${e.toString()})(${it.toString()}, ${JSON.stringify(n)}${t.map((s) => `, "${s}"`).join('')})`;
}
const Fn = [
    'about:',
    'blob:',
    'data:',
    'file:',
    'ftp:',
    'http:',
    'https:',
    'mailto:',
    'sftp:',
    'ws:',
    'wss:',
  ],
  Ft = 'http://playwright.bloburl/#';
function rt(n) {
  n.startsWith(Ft) && (n = n.substring(Ft.length));
  try {
    const t = new URL(n);
    if (t.protocol === 'javascript:' || t.protocol === 'vbscript:') return 'javascript:void(0)';
    const e = t.protocol === 'blob:',
      s = t.protocol === 'file:';
    if (!e && !s && Fn.includes(t.protocol)) return n;
    const r = 'pw-' + t.protocol.slice(0, t.protocol.length - 1);
    return (
      s || (t.protocol = 'https:'),
      (t.hostname = t.hostname ? `${r}--${t.hostname}` : r),
      s && (t.protocol = 'https:'),
      t.toString()
    );
  } catch {
    return n;
  }
}
const er = /url\(['"]?([\w-]+:)\/\//gi;
function tr(n) {
  return n.replace(er, (t, e) =>
    !(e === 'blob:') && !(e === 'file:') && Fn.includes(e)
      ? t
      : t.replace(e + '//', `https://pw-${e.slice(0, -1)}--`)
  );
}
function it(n) {
  const t = new URL(n);
  return t.pathname.endsWith('/snapshot.html') ? t.searchParams.get('r') : n;
}
class nr {
  constructor(t, e) {
    v(this, '_snapshotStorage');
    v(this, '_resourceLoader');
    v(this, '_snapshotIds', new Map());
    (this._snapshotStorage = t), (this._resourceLoader = e);
  }
  serveSnapshot(t, e, s) {
    const r = this._snapshot(t, e);
    if (!r) return new Response(null, { status: 404 });
    const i = r.render();
    return (
      this._snapshotIds.set(s, r),
      new Response(i.html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    );
  }
  async serveClosestScreenshot(t, e) {
    const s = this._snapshot(t, e),
      r = s == null ? void 0 : s.closestScreenshot();
    return r ? new Response(await this._resourceLoader(r)) : new Response(null, { status: 404 });
  }
  serveSnapshotInfo(t, e) {
    const s = this._snapshot(t, e);
    return this._respondWithJson(
      s
        ? {
            viewport: s.viewport(),
            url: s.snapshot().frameUrl,
            timestamp: s.snapshot().timestamp,
            wallTime: s.snapshot().wallTime,
          }
        : { error: 'No snapshot found' }
    );
  }
  _snapshot(t, e) {
    const s = e.get('name');
    return this._snapshotStorage.snapshotByName(t, s);
  }
  _respondWithJson(t) {
    return new Response(JSON.stringify(t), {
      status: 200,
      headers: { 'Cache-Control': 'public, max-age=31536000', 'Content-Type': 'application/json' },
    });
  }
  async serveResource(t, e, s) {
    let r;
    const i = this._snapshotIds.get(s);
    for (const S of t) if (((r = i == null ? void 0 : i.resourceByUrl(sr(S), e)), r)) break;
    if (!r) return new Response(null, { status: 404 });
    const a = r.response.content._sha1,
      c = a ? (await this._resourceLoader(a)) || new Blob([]) : new Blob([]);
    let l = r.response.content.mimeType;
    /^text\/|^application\/(javascript|json)/.test(l) &&
      !l.includes('charset') &&
      (l = `${l}; charset=utf-8`);
    const f = new Headers();
    l !== 'x-unknown' && f.set('Content-Type', l);
    for (const { name: S, value: C } of r.response.headers) f.set(S, C);
    f.delete('Content-Encoding'),
      f.delete('Access-Control-Allow-Origin'),
      f.set('Access-Control-Allow-Origin', '*'),
      f.delete('Content-Length'),
      f.set('Content-Length', String(c.size)),
      f.set('Cache-Control', 'public, max-age=31536000');
    const { status: b } = r.response,
      h = b === 101 || b === 204 || b === 205 || b === 304;
    return new Response(h ? null : c, {
      headers: f,
      status: r.response.status,
      statusText: r.response.statusText,
    });
  }
}
function sr(n) {
  try {
    const t = new URL(n);
    return (t.hash = ''), t.toString();
  } catch {
    return n;
  }
}
function rr(n) {
  const t = new Map(),
    { files: e, stacks: s } = n;
  for (const r of s) {
    const [i, a] = r;
    t.set(
      `call@${i}`,
      a.map((c) => ({ file: e[c[0]], line: c[1], column: c[2], function: c[3] }))
    );
  }
  return t;
}
class ir {
  constructor(t) {
    v(this, '_maxSize');
    v(this, '_map');
    v(this, '_size');
    (this._maxSize = t), (this._map = new Map()), (this._size = 0);
  }
  getOrCompute(t, e) {
    if (this._map.has(t)) {
      const r = this._map.get(t);
      return this._map.delete(t), this._map.set(t, r), r.value;
    }
    const s = e();
    for (; this._map.size && this._size + s.size > this._maxSize; ) {
      const [r, i] = this._map.entries().next().value;
      (this._size -= i.size), this._map.delete(r);
    }
    return this._map.set(t, s), (this._size += s.size), s.value;
  }
}
class ar {
  constructor() {
    v(this, '_frameSnapshots', new Map());
    v(this, '_cache', new ir(1e8));
    v(this, '_contextToResources', new Map());
  }
  addResource(t, e) {
    (e.request.url = rt(e.request.url)), this._ensureResourcesForContext(t).push(e);
  }
  addFrameSnapshot(t, e, s) {
    for (const c of e.resourceOverrides) c.url = rt(c.url);
    let r = this._frameSnapshots.get(e.frameId);
    r ||
      ((r = { raw: [], renderers: [] }),
      this._frameSnapshots.set(e.frameId, r),
      e.isMainFrame && this._frameSnapshots.set(e.pageId, r)),
      r.raw.push(e);
    const i = this._ensureResourcesForContext(t),
      a = new $s(this._cache, i, r.raw, s, r.raw.length - 1);
    return r.renderers.push(a), a;
  }
  snapshotByName(t, e) {
    const s = this._frameSnapshots.get(t);
    return s == null ? void 0 : s.renderers.find((r) => r.snapshotName === e);
  }
  snapshotsForTest() {
    return [...this._frameSnapshots.keys()];
  }
  finalize() {
    for (const t of this._contextToResources.values())
      t.sort((e, s) => (e._monotonicTime || 0) - (s._monotonicTime || 0));
  }
  _ensureResourcesForContext(t) {
    let e = this._contextToResources.get(t);
    return e || ((e = []), this._contextToResources.set(t, e)), e;
  }
}
class Un extends Error {
  constructor(t) {
    super(t), (this.name = 'TraceVersionError');
  }
}
const Ut = 7;
class or {
  constructor(t, e) {
    v(this, '_contextEntry');
    v(this, '_snapshotStorage');
    v(this, '_actionMap', new Map());
    v(this, '_version');
    v(this, '_pageEntries', new Map());
    v(this, '_jsHandles', new Map());
    v(this, '_consoleObjects', new Map());
    (this._contextEntry = t), (this._snapshotStorage = e);
  }
  appendTrace(t) {
    for (const e of t.split(`
`))
      this._appendEvent(e);
  }
  actions() {
    return [...this._actionMap.values()];
  }
  _pageEntry(t) {
    let e = this._pageEntries.get(t);
    return (
      e ||
        ((e = { pageId: t, screencastFrames: [] }),
        this._pageEntries.set(t, e),
        this._contextEntry.pages.push(e)),
      e
    );
  }
  _appendEvent(t) {
    if (!t) return;
    const e = this._modernize(JSON.parse(t));
    for (const s of e) this._innerAppendEvent(s);
  }
  _innerAppendEvent(t) {
    const e = this._contextEntry;
    switch (t.type) {
      case 'context-options': {
        if (t.version > Ut)
          throw new Un(
            'The trace was created by a newer version of Playwright and is not supported by this version of the viewer. Please use latest Playwright to open the trace.'
          );
        (this._version = t.version),
          (e.origin = t.origin),
          (e.browserName = t.browserName),
          (e.channel = t.channel),
          (e.title = t.title),
          (e.platform = t.platform),
          (e.wallTime = t.wallTime),
          (e.startTime = t.monotonicTime),
          (e.sdkLanguage = t.sdkLanguage),
          (e.options = t.options),
          (e.testIdAttributeName = t.testIdAttributeName),
          (e.contextId = t.contextId ?? '');
        break;
      }
      case 'screencast-frame': {
        this._pageEntry(t.pageId).screencastFrames.push(t);
        break;
      }
      case 'before': {
        this._actionMap.set(t.callId, { ...t, type: 'action', endTime: 0, log: [] });
        break;
      }
      case 'input': {
        const s = this._actionMap.get(t.callId);
        (s.inputSnapshot = t.inputSnapshot), (s.point = t.point);
        break;
      }
      case 'log': {
        const s = this._actionMap.get(t.callId);
        if (!s) return;
        s.log.push({ time: t.time, message: t.message });
        break;
      }
      case 'after': {
        const s = this._actionMap.get(t.callId);
        (s.afterSnapshot = t.afterSnapshot),
          (s.endTime = t.endTime),
          (s.result = t.result),
          (s.error = t.error),
          (s.attachments = t.attachments),
          (s.annotations = t.annotations),
          t.point && (s.point = t.point);
        break;
      }
      case 'action': {
        this._actionMap.set(t.callId, { ...t, log: [] });
        break;
      }
      case 'event': {
        e.events.push(t);
        break;
      }
      case 'stdout': {
        e.stdio.push(t);
        break;
      }
      case 'stderr': {
        e.stdio.push(t);
        break;
      }
      case 'error': {
        e.errors.push(t);
        break;
      }
      case 'console': {
        e.events.push(t);
        break;
      }
      case 'resource-snapshot':
        this._snapshotStorage.addResource(this._contextEntry.contextId, t.snapshot),
          e.resources.push(t.snapshot);
        break;
      case 'frame-snapshot':
        this._snapshotStorage.addFrameSnapshot(
          this._contextEntry.contextId,
          t.snapshot,
          this._pageEntry(t.snapshot.pageId).screencastFrames
        );
        break;
    }
    'pageId' in t && t.pageId && this._pageEntry(t.pageId),
      (t.type === 'action' || t.type === 'before') &&
        (e.startTime = Math.min(e.startTime, t.startTime)),
      (t.type === 'action' || t.type === 'after') && (e.endTime = Math.max(e.endTime, t.endTime)),
      t.type === 'event' &&
        ((e.startTime = Math.min(e.startTime, t.time)), (e.endTime = Math.max(e.endTime, t.time))),
      t.type === 'screencast-frame' &&
        ((e.startTime = Math.min(e.startTime, t.timestamp)),
        (e.endTime = Math.max(e.endTime, t.timestamp)));
  }
  _processedContextCreatedEvent() {
    return this._version !== void 0;
  }
  _modernize(t) {
    let e = this._version || t.version;
    if (e === void 0) return [t];
    let s = [t];
    for (; e < Ut; ++e) s = this[`_modernize_${e}_to_${e + 1}`].call(this, s);
    return s;
  }
  _modernize_0_to_1(t) {
    for (const e of t)
      e.type === 'action' &&
        typeof e.metadata.error == 'string' &&
        (e.metadata.error = { error: { name: 'Error', message: e.metadata.error } });
    return t;
  }
  _modernize_1_to_2(t) {
    var e;
    for (const s of t)
      s.type !== 'frame-snapshot' ||
        !s.snapshot.isMainFrame ||
        (s.snapshot.viewport = ((e = this._contextEntry.options) == null ? void 0 : e.viewport) || {
          width: 1280,
          height: 720,
        });
    return t;
  }
  _modernize_2_to_3(t) {
    for (const e of t) {
      if (e.type !== 'resource-snapshot' || e.snapshot.request) continue;
      const s = e.snapshot;
      e.snapshot = {
        _frameref: s.frameId,
        request: {
          url: s.url,
          method: s.method,
          headers: s.requestHeaders,
          postData: s.requestSha1 ? { _sha1: s.requestSha1 } : void 0,
        },
        response: {
          status: s.status,
          headers: s.responseHeaders,
          content: { mimeType: s.contentType, _sha1: s.responseSha1 },
        },
        _monotonicTime: s.timestamp,
      };
    }
    return t;
  }
  _modernize_3_to_4(t) {
    const e = [];
    for (const s of t) {
      const r = this._modernize_event_3_to_4(s);
      r && e.push(r);
    }
    return e;
  }
  _modernize_event_3_to_4(t) {
    var s, r, i, a;
    if (t.type !== 'action' && t.type !== 'event') return t;
    const e = t.metadata;
    return e.internal || e.method.startsWith('tracing')
      ? null
      : t.type === 'event'
        ? e.method === '__create__' && e.type === 'ConsoleMessage'
          ? {
              type: 'object',
              class: e.type,
              guid: e.params.guid,
              initializer: e.params.initializer,
            }
          : {
              type: 'event',
              time: e.startTime,
              class: e.type,
              method: e.method,
              params: e.params,
              pageId: e.pageId,
            }
        : {
            type: 'action',
            callId: e.id,
            startTime: e.startTime,
            endTime: e.endTime,
            apiName: e.apiName || e.type + '.' + e.method,
            class: e.type,
            method: e.method,
            params: e.params,
            wallTime: e.wallTime || Date.now(),
            log: e.log,
            beforeSnapshot:
              (s = e.snapshots.find((c) => c.title === 'before')) == null ? void 0 : s.snapshotName,
            inputSnapshot:
              (r = e.snapshots.find((c) => c.title === 'input')) == null ? void 0 : r.snapshotName,
            afterSnapshot:
              (i = e.snapshots.find((c) => c.title === 'after')) == null ? void 0 : i.snapshotName,
            error: (a = e.error) == null ? void 0 : a.error,
            result: e.result,
            point: e.point,
            pageId: e.pageId,
          };
  }
  _modernize_4_to_5(t) {
    const e = [];
    for (const s of t) {
      const r = this._modernize_event_4_to_5(s);
      r && e.push(r);
    }
    return e;
  }
  _modernize_event_4_to_5(t) {
    var e, s;
    if (
      (t.type === 'event' &&
        t.method === '__create__' &&
        t.class === 'JSHandle' &&
        this._jsHandles.set(t.params.guid, t.params.initializer),
      t.type === 'object')
    ) {
      if (t.class !== 'ConsoleMessage') return null;
      const r =
        (e = t.initializer.args) == null
          ? void 0
          : e.map((i) => {
              if (i.guid) {
                const a = this._jsHandles.get(i.guid);
                return { preview: (a == null ? void 0 : a.preview) || '', value: '' };
              }
              return { preview: i.preview || '', value: i.value || '' };
            });
      return (
        this._consoleObjects.set(t.guid, {
          type: t.initializer.type,
          text: t.initializer.text,
          location: t.initializer.location,
          args: r,
        }),
        null
      );
    }
    if (t.type === 'event' && t.method === 'console') {
      const r = this._consoleObjects.get(((s = t.params.message) == null ? void 0 : s.guid) || '');
      return r
        ? {
            type: 'console',
            time: t.time,
            pageId: t.pageId,
            messageType: r.type,
            text: r.text,
            args: r.args,
            location: r.location,
          }
        : null;
    }
    return t;
  }
  _modernize_5_to_6(t) {
    const e = [];
    for (const s of t)
      if ((e.push(s), !(s.type !== 'after' || !s.log.length)))
        for (const r of s.log) e.push({ type: 'log', callId: s.callId, message: r, time: -1 });
    return e;
  }
  _modernize_6_to_7(t) {
    const e = [];
    if (!this._processedContextCreatedEvent() && t[0].type !== 'context-options') {
      const s = {
        type: 'context-options',
        origin: 'testRunner',
        version: 7,
        browserName: '',
        options: {},
        platform: process.platform,
        wallTime: 0,
        monotonicTime: 0,
        sdkLanguage: 'javascript',
        contextId: '',
      };
      e.push(s);
    }
    for (const s of t) {
      if (s.type === 'context-options') {
        e.push({ ...s, monotonicTime: 0, origin: 'library', contextId: '' });
        continue;
      }
      !this._contextEntry.wallTime &&
        s.type === 'before' &&
        (this._contextEntry.wallTime = s.wallTime),
        !this._contextEntry.startTime &&
          s.type === 'before' &&
          (this._contextEntry.startTime = s.startTime),
        e.push(s);
    }
    return e;
  }
}
class cr {
  constructor() {
    v(this, 'contextEntries', []);
    v(this, '_snapshotStorage');
    v(this, '_backend');
    v(this, '_resourceToContentType', new Map());
  }
  async load(t, e) {
    var c, l;
    this._backend = t;
    const s = [];
    let r = !1;
    for (const _ of await this._backend.entryNames()) {
      const f = _.match(/(.+)\.trace$/);
      f && s.push(f[1] || ''), _.includes('src@') && (r = !0);
    }
    if (!s.length) throw new Error('Cannot find .trace file');
    this._snapshotStorage = new ar();
    const i = s.length * 3;
    let a = 0;
    for (const _ of s) {
      const f = lr();
      (f.traceUrl = t.traceURL()), (f.hasSource = r);
      const b = new or(f, this._snapshotStorage),
        h = (await this._backend.readText(_ + '.trace')) || '';
      b.appendTrace(h), e(++a, i);
      const S = (await this._backend.readText(_ + '.network')) || '';
      if (
        (b.appendTrace(S),
        e(++a, i),
        (f.actions = b.actions().sort((u, o) => u.startTime - o.startTime)),
        !t.isLive())
      ) {
        for (const u of f.actions.slice().reverse())
          if (!u.endTime && !u.error)
            for (const o of f.actions)
              o.parentId === u.callId && u.endTime < o.endTime && (u.endTime = o.endTime);
      }
      const C = await this._backend.readText(_ + '.stacks');
      if (C) {
        const u = rr(JSON.parse(C));
        for (const o of f.actions) o.stack = o.stack || u.get(o.callId);
      }
      e(++a, i);
      for (const u of f.resources)
        (c = u.request.postData) != null &&
          c._sha1 &&
          this._resourceToContentType.set(
            u.request.postData._sha1,
            Mt(u.request.postData.mimeType)
          ),
          (l = u.response.content) != null &&
            l._sha1 &&
            this._resourceToContentType.set(
              u.response.content._sha1,
              Mt(u.response.content.mimeType)
            );
      this.contextEntries.push(f);
    }
    this._snapshotStorage.finalize();
  }
  async hasEntry(t) {
    return this._backend.hasEntry(t);
  }
  async resourceForSha1(t) {
    const e = await this._backend.readBlob('resources/' + t),
      s = this._resourceToContentType.get(t);
    return !e || s === void 0 || s === 'x-unknown' ? e : new Blob([e], { type: s });
  }
  storage() {
    return this._snapshotStorage;
  }
}
function Mt(n) {
  const t = n.match(/^(.*);\s*charset=.*$/);
  return t ? t[1] : n;
}
function lr() {
  return {
    origin: 'testRunner',
    traceUrl: '',
    startTime: Number.MAX_SAFE_INTEGER,
    wallTime: Number.MAX_SAFE_INTEGER,
    endTime: 0,
    browserName: '',
    options: { deviceScaleFactor: 1, isMobile: !1, viewport: { width: 1280, height: 800 } },
    pages: [],
    resources: [],
    actions: [],
    events: [],
    errors: [],
    stdio: [],
    hasSource: !1,
    contextId: '',
  };
}
const fr = 15,
  F = 0,
  ee = 1,
  ur = 2,
  X = -2,
  H = -3,
  Wt = -4,
  te = -5,
  $ = [0, 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383, 32767, 65535],
  Mn = 1440,
  dr = 0,
  _r = 4,
  hr = 9,
  pr = 5,
  mr = [
    96, 7, 256, 0, 8, 80, 0, 8, 16, 84, 8, 115, 82, 7, 31, 0, 8, 112, 0, 8, 48, 0, 9, 192, 80, 7,
    10, 0, 8, 96, 0, 8, 32, 0, 9, 160, 0, 8, 0, 0, 8, 128, 0, 8, 64, 0, 9, 224, 80, 7, 6, 0, 8, 88,
    0, 8, 24, 0, 9, 144, 83, 7, 59, 0, 8, 120, 0, 8, 56, 0, 9, 208, 81, 7, 17, 0, 8, 104, 0, 8, 40,
    0, 9, 176, 0, 8, 8, 0, 8, 136, 0, 8, 72, 0, 9, 240, 80, 7, 4, 0, 8, 84, 0, 8, 20, 85, 8, 227,
    83, 7, 43, 0, 8, 116, 0, 8, 52, 0, 9, 200, 81, 7, 13, 0, 8, 100, 0, 8, 36, 0, 9, 168, 0, 8, 4,
    0, 8, 132, 0, 8, 68, 0, 9, 232, 80, 7, 8, 0, 8, 92, 0, 8, 28, 0, 9, 152, 84, 7, 83, 0, 8, 124,
    0, 8, 60, 0, 9, 216, 82, 7, 23, 0, 8, 108, 0, 8, 44, 0, 9, 184, 0, 8, 12, 0, 8, 140, 0, 8, 76,
    0, 9, 248, 80, 7, 3, 0, 8, 82, 0, 8, 18, 85, 8, 163, 83, 7, 35, 0, 8, 114, 0, 8, 50, 0, 9, 196,
    81, 7, 11, 0, 8, 98, 0, 8, 34, 0, 9, 164, 0, 8, 2, 0, 8, 130, 0, 8, 66, 0, 9, 228, 80, 7, 7, 0,
    8, 90, 0, 8, 26, 0, 9, 148, 84, 7, 67, 0, 8, 122, 0, 8, 58, 0, 9, 212, 82, 7, 19, 0, 8, 106, 0,
    8, 42, 0, 9, 180, 0, 8, 10, 0, 8, 138, 0, 8, 74, 0, 9, 244, 80, 7, 5, 0, 8, 86, 0, 8, 22, 192,
    8, 0, 83, 7, 51, 0, 8, 118, 0, 8, 54, 0, 9, 204, 81, 7, 15, 0, 8, 102, 0, 8, 38, 0, 9, 172, 0,
    8, 6, 0, 8, 134, 0, 8, 70, 0, 9, 236, 80, 7, 9, 0, 8, 94, 0, 8, 30, 0, 9, 156, 84, 7, 99, 0, 8,
    126, 0, 8, 62, 0, 9, 220, 82, 7, 27, 0, 8, 110, 0, 8, 46, 0, 9, 188, 0, 8, 14, 0, 8, 142, 0, 8,
    78, 0, 9, 252, 96, 7, 256, 0, 8, 81, 0, 8, 17, 85, 8, 131, 82, 7, 31, 0, 8, 113, 0, 8, 49, 0, 9,
    194, 80, 7, 10, 0, 8, 97, 0, 8, 33, 0, 9, 162, 0, 8, 1, 0, 8, 129, 0, 8, 65, 0, 9, 226, 80, 7,
    6, 0, 8, 89, 0, 8, 25, 0, 9, 146, 83, 7, 59, 0, 8, 121, 0, 8, 57, 0, 9, 210, 81, 7, 17, 0, 8,
    105, 0, 8, 41, 0, 9, 178, 0, 8, 9, 0, 8, 137, 0, 8, 73, 0, 9, 242, 80, 7, 4, 0, 8, 85, 0, 8, 21,
    80, 8, 258, 83, 7, 43, 0, 8, 117, 0, 8, 53, 0, 9, 202, 81, 7, 13, 0, 8, 101, 0, 8, 37, 0, 9,
    170, 0, 8, 5, 0, 8, 133, 0, 8, 69, 0, 9, 234, 80, 7, 8, 0, 8, 93, 0, 8, 29, 0, 9, 154, 84, 7,
    83, 0, 8, 125, 0, 8, 61, 0, 9, 218, 82, 7, 23, 0, 8, 109, 0, 8, 45, 0, 9, 186, 0, 8, 13, 0, 8,
    141, 0, 8, 77, 0, 9, 250, 80, 7, 3, 0, 8, 83, 0, 8, 19, 85, 8, 195, 83, 7, 35, 0, 8, 115, 0, 8,
    51, 0, 9, 198, 81, 7, 11, 0, 8, 99, 0, 8, 35, 0, 9, 166, 0, 8, 3, 0, 8, 131, 0, 8, 67, 0, 9,
    230, 80, 7, 7, 0, 8, 91, 0, 8, 27, 0, 9, 150, 84, 7, 67, 0, 8, 123, 0, 8, 59, 0, 9, 214, 82, 7,
    19, 0, 8, 107, 0, 8, 43, 0, 9, 182, 0, 8, 11, 0, 8, 139, 0, 8, 75, 0, 9, 246, 80, 7, 5, 0, 8,
    87, 0, 8, 23, 192, 8, 0, 83, 7, 51, 0, 8, 119, 0, 8, 55, 0, 9, 206, 81, 7, 15, 0, 8, 103, 0, 8,
    39, 0, 9, 174, 0, 8, 7, 0, 8, 135, 0, 8, 71, 0, 9, 238, 80, 7, 9, 0, 8, 95, 0, 8, 31, 0, 9, 158,
    84, 7, 99, 0, 8, 127, 0, 8, 63, 0, 9, 222, 82, 7, 27, 0, 8, 111, 0, 8, 47, 0, 9, 190, 0, 8, 15,
    0, 8, 143, 0, 8, 79, 0, 9, 254, 96, 7, 256, 0, 8, 80, 0, 8, 16, 84, 8, 115, 82, 7, 31, 0, 8,
    112, 0, 8, 48, 0, 9, 193, 80, 7, 10, 0, 8, 96, 0, 8, 32, 0, 9, 161, 0, 8, 0, 0, 8, 128, 0, 8,
    64, 0, 9, 225, 80, 7, 6, 0, 8, 88, 0, 8, 24, 0, 9, 145, 83, 7, 59, 0, 8, 120, 0, 8, 56, 0, 9,
    209, 81, 7, 17, 0, 8, 104, 0, 8, 40, 0, 9, 177, 0, 8, 8, 0, 8, 136, 0, 8, 72, 0, 9, 241, 80, 7,
    4, 0, 8, 84, 0, 8, 20, 85, 8, 227, 83, 7, 43, 0, 8, 116, 0, 8, 52, 0, 9, 201, 81, 7, 13, 0, 8,
    100, 0, 8, 36, 0, 9, 169, 0, 8, 4, 0, 8, 132, 0, 8, 68, 0, 9, 233, 80, 7, 8, 0, 8, 92, 0, 8, 28,
    0, 9, 153, 84, 7, 83, 0, 8, 124, 0, 8, 60, 0, 9, 217, 82, 7, 23, 0, 8, 108, 0, 8, 44, 0, 9, 185,
    0, 8, 12, 0, 8, 140, 0, 8, 76, 0, 9, 249, 80, 7, 3, 0, 8, 82, 0, 8, 18, 85, 8, 163, 83, 7, 35,
    0, 8, 114, 0, 8, 50, 0, 9, 197, 81, 7, 11, 0, 8, 98, 0, 8, 34, 0, 9, 165, 0, 8, 2, 0, 8, 130, 0,
    8, 66, 0, 9, 229, 80, 7, 7, 0, 8, 90, 0, 8, 26, 0, 9, 149, 84, 7, 67, 0, 8, 122, 0, 8, 58, 0, 9,
    213, 82, 7, 19, 0, 8, 106, 0, 8, 42, 0, 9, 181, 0, 8, 10, 0, 8, 138, 0, 8, 74, 0, 9, 245, 80, 7,
    5, 0, 8, 86, 0, 8, 22, 192, 8, 0, 83, 7, 51, 0, 8, 118, 0, 8, 54, 0, 9, 205, 81, 7, 15, 0, 8,
    102, 0, 8, 38, 0, 9, 173, 0, 8, 6, 0, 8, 134, 0, 8, 70, 0, 9, 237, 80, 7, 9, 0, 8, 94, 0, 8, 30,
    0, 9, 157, 84, 7, 99, 0, 8, 126, 0, 8, 62, 0, 9, 221, 82, 7, 27, 0, 8, 110, 0, 8, 46, 0, 9, 189,
    0, 8, 14, 0, 8, 142, 0, 8, 78, 0, 9, 253, 96, 7, 256, 0, 8, 81, 0, 8, 17, 85, 8, 131, 82, 7, 31,
    0, 8, 113, 0, 8, 49, 0, 9, 195, 80, 7, 10, 0, 8, 97, 0, 8, 33, 0, 9, 163, 0, 8, 1, 0, 8, 129, 0,
    8, 65, 0, 9, 227, 80, 7, 6, 0, 8, 89, 0, 8, 25, 0, 9, 147, 83, 7, 59, 0, 8, 121, 0, 8, 57, 0, 9,
    211, 81, 7, 17, 0, 8, 105, 0, 8, 41, 0, 9, 179, 0, 8, 9, 0, 8, 137, 0, 8, 73, 0, 9, 243, 80, 7,
    4, 0, 8, 85, 0, 8, 21, 80, 8, 258, 83, 7, 43, 0, 8, 117, 0, 8, 53, 0, 9, 203, 81, 7, 13, 0, 8,
    101, 0, 8, 37, 0, 9, 171, 0, 8, 5, 0, 8, 133, 0, 8, 69, 0, 9, 235, 80, 7, 8, 0, 8, 93, 0, 8, 29,
    0, 9, 155, 84, 7, 83, 0, 8, 125, 0, 8, 61, 0, 9, 219, 82, 7, 23, 0, 8, 109, 0, 8, 45, 0, 9, 187,
    0, 8, 13, 0, 8, 141, 0, 8, 77, 0, 9, 251, 80, 7, 3, 0, 8, 83, 0, 8, 19, 85, 8, 195, 83, 7, 35,
    0, 8, 115, 0, 8, 51, 0, 9, 199, 81, 7, 11, 0, 8, 99, 0, 8, 35, 0, 9, 167, 0, 8, 3, 0, 8, 131, 0,
    8, 67, 0, 9, 231, 80, 7, 7, 0, 8, 91, 0, 8, 27, 0, 9, 151, 84, 7, 67, 0, 8, 123, 0, 8, 59, 0, 9,
    215, 82, 7, 19, 0, 8, 107, 0, 8, 43, 0, 9, 183, 0, 8, 11, 0, 8, 139, 0, 8, 75, 0, 9, 247, 80, 7,
    5, 0, 8, 87, 0, 8, 23, 192, 8, 0, 83, 7, 51, 0, 8, 119, 0, 8, 55, 0, 9, 207, 81, 7, 15, 0, 8,
    103, 0, 8, 39, 0, 9, 175, 0, 8, 7, 0, 8, 135, 0, 8, 71, 0, 9, 239, 80, 7, 9, 0, 8, 95, 0, 8, 31,
    0, 9, 159, 84, 7, 99, 0, 8, 127, 0, 8, 63, 0, 9, 223, 82, 7, 27, 0, 8, 111, 0, 8, 47, 0, 9, 191,
    0, 8, 15, 0, 8, 143, 0, 8, 79, 0, 9, 255,
  ],
  wr = [
    80, 5, 1, 87, 5, 257, 83, 5, 17, 91, 5, 4097, 81, 5, 5, 89, 5, 1025, 85, 5, 65, 93, 5, 16385,
    80, 5, 3, 88, 5, 513, 84, 5, 33, 92, 5, 8193, 82, 5, 9, 90, 5, 2049, 86, 5, 129, 192, 5, 24577,
    80, 5, 2, 87, 5, 385, 83, 5, 25, 91, 5, 6145, 81, 5, 7, 89, 5, 1537, 85, 5, 97, 93, 5, 24577,
    80, 5, 4, 88, 5, 769, 84, 5, 49, 92, 5, 12289, 82, 5, 13, 90, 5, 3073, 86, 5, 193, 192, 5,
    24577,
  ],
  gr = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258, 0, 0,
  ],
  br = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 112, 112,
  ],
  yr = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
    3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ],
  xr = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
  ],
  ne = 15;
function at() {
  const n = this;
  let t, e, s, r, i, a;
  function c(_, f, b, h, S, C, u, o, d, y, g) {
    let w, E, p, R, T, A, x, m, I, O, N, P, D, M, L;
    (O = 0), (T = b);
    do s[_[f + O]]++, O++, T--;
    while (T !== 0);
    if (s[0] == b) return (u[0] = -1), (o[0] = 0), F;
    for (m = o[0], A = 1; A <= ne && s[A] === 0; A++);
    for (x = A, m < A && (m = A), T = ne; T !== 0 && s[T] === 0; T--);
    for (p = T, m > T && (m = T), o[0] = m, M = 1 << A; A < T; A++, M <<= 1)
      if ((M -= s[A]) < 0) return H;
    if ((M -= s[T]) < 0) return H;
    for (s[T] += M, a[1] = A = 0, O = 1, D = 2; --T !== 0; ) (a[D] = A += s[O]), D++, O++;
    (T = 0), (O = 0);
    do (A = _[f + O]) !== 0 && (g[a[A]++] = T), O++;
    while (++T < b);
    for (b = a[p], a[0] = T = 0, O = 0, R = -1, P = -m, i[0] = 0, N = 0, L = 0; x <= p; x++)
      for (w = s[x]; w-- !== 0; ) {
        for (; x > P + m; ) {
          if (
            (R++,
            (P += m),
            (L = p - P),
            (L = L > m ? m : L),
            (E = 1 << (A = x - P)) > w + 1 && ((E -= w + 1), (D = x), A < L))
          )
            for (; ++A < L && !((E <<= 1) <= s[++D]); ) E -= s[D];
          if (((L = 1 << A), y[0] + L > Mn)) return H;
          (i[R] = N = y[0]),
            (y[0] += L),
            R !== 0
              ? ((a[R] = T),
                (r[0] = A),
                (r[1] = m),
                (A = T >>> (P - m)),
                (r[2] = N - i[R - 1] - A),
                d.set(r, (i[R - 1] + A) * 3))
              : (u[0] = N);
        }
        for (
          r[1] = x - P,
            O >= b
              ? (r[0] = 192)
              : g[O] < h
                ? ((r[0] = g[O] < 256 ? 0 : 96), (r[2] = g[O++]))
                : ((r[0] = C[g[O] - h] + 16 + 64), (r[2] = S[g[O++] - h])),
            E = 1 << (x - P),
            A = T >>> P;
          A < L;
          A += E
        )
          d.set(r, (N + A) * 3);
        for (A = 1 << (x - 1); T & A; A >>>= 1) T ^= A;
        for (T ^= A, I = (1 << P) - 1; (T & I) != a[R]; ) R--, (P -= m), (I = (1 << P) - 1);
      }
    return M !== 0 && p != 1 ? te : F;
  }
  function l(_) {
    let f;
    for (
      t ||
        ((t = []),
        (e = []),
        (s = new Int32Array(ne + 1)),
        (r = []),
        (i = new Int32Array(ne)),
        (a = new Int32Array(ne + 1))),
        e.length < _ && (e = []),
        f = 0;
      f < _;
      f++
    )
      e[f] = 0;
    for (f = 0; f < ne + 1; f++) s[f] = 0;
    for (f = 0; f < 3; f++) r[f] = 0;
    i.set(s.subarray(0, ne), 0), a.set(s.subarray(0, ne + 1), 0);
  }
  (n.inflate_trees_bits = function (_, f, b, h, S) {
    let C;
    return (
      l(19),
      (t[0] = 0),
      (C = c(_, 0, 19, 19, null, null, b, f, h, t, e)),
      C == H
        ? (S.msg = 'oversubscribed dynamic bit lengths tree')
        : (C == te || f[0] === 0) && ((S.msg = 'incomplete dynamic bit lengths tree'), (C = H)),
      C
    );
  }),
    (n.inflate_trees_dynamic = function (_, f, b, h, S, C, u, o, d) {
      let y;
      return (
        l(288),
        (t[0] = 0),
        (y = c(b, 0, _, 257, gr, br, C, h, o, t, e)),
        y != F || h[0] === 0
          ? (y == H
              ? (d.msg = 'oversubscribed literal/length tree')
              : y != Wt && ((d.msg = 'incomplete literal/length tree'), (y = H)),
            y)
          : (l(288),
            (y = c(b, _, f, 0, yr, xr, u, S, o, t, e)),
            y != F || (S[0] === 0 && _ > 257)
              ? (y == H
                  ? (d.msg = 'oversubscribed distance tree')
                  : y == te
                    ? ((d.msg = 'incomplete distance tree'), (y = H))
                    : y != Wt && ((d.msg = 'empty distance tree with lengths'), (y = H)),
                y)
              : F)
      );
    });
}
at.inflate_trees_fixed = function (n, t, e, s) {
  return (n[0] = hr), (t[0] = pr), (e[0] = mr), (s[0] = wr), F;
};
const Ne = 0,
  Ht = 1,
  Bt = 2,
  jt = 3,
  qt = 4,
  Yt = 5,
  Gt = 6,
  Xe = 7,
  Vt = 8,
  Le = 9;
function Er() {
  const n = this;
  let t,
    e = 0,
    s,
    r = 0,
    i = 0,
    a = 0,
    c = 0,
    l = 0,
    _ = 0,
    f = 0,
    b,
    h = 0,
    S,
    C = 0;
  function u(o, d, y, g, w, E, p, R) {
    let T, A, x, m, I, O, N, P, D, M, L, Y, k, _e, U, W;
    (N = R.next_in_index),
      (P = R.avail_in),
      (I = p.bitb),
      (O = p.bitk),
      (D = p.write),
      (M = D < p.read ? p.read - D - 1 : p.end - D),
      (L = $[o]),
      (Y = $[d]);
    do {
      for (; O < 20; ) P--, (I |= (R.read_byte(N++) & 255) << O), (O += 8);
      if (((T = I & L), (A = y), (x = g), (W = (x + T) * 3), (m = A[W]) === 0)) {
        (I >>= A[W + 1]), (O -= A[W + 1]), (p.win[D++] = A[W + 2]), M--;
        continue;
      }
      do {
        if (((I >>= A[W + 1]), (O -= A[W + 1]), m & 16)) {
          for (m &= 15, k = A[W + 2] + (I & $[m]), I >>= m, O -= m; O < 15; )
            P--, (I |= (R.read_byte(N++) & 255) << O), (O += 8);
          (T = I & Y), (A = w), (x = E), (W = (x + T) * 3), (m = A[W]);
          do
            if (((I >>= A[W + 1]), (O -= A[W + 1]), m & 16)) {
              for (m &= 15; O < m; ) P--, (I |= (R.read_byte(N++) & 255) << O), (O += 8);
              if (((_e = A[W + 2] + (I & $[m])), (I >>= m), (O -= m), (M -= k), D >= _e))
                (U = D - _e),
                  D - U > 0 && 2 > D - U
                    ? ((p.win[D++] = p.win[U++]), (p.win[D++] = p.win[U++]), (k -= 2))
                    : (p.win.set(p.win.subarray(U, U + 2), D), (D += 2), (U += 2), (k -= 2));
              else {
                U = D - _e;
                do U += p.end;
                while (U < 0);
                if (((m = p.end - U), k > m)) {
                  if (((k -= m), D - U > 0 && m > D - U))
                    do p.win[D++] = p.win[U++];
                    while (--m !== 0);
                  else p.win.set(p.win.subarray(U, U + m), D), (D += m), (U += m), (m = 0);
                  U = 0;
                }
              }
              if (D - U > 0 && k > D - U)
                do p.win[D++] = p.win[U++];
                while (--k !== 0);
              else p.win.set(p.win.subarray(U, U + k), D), (D += k), (U += k), (k = 0);
              break;
            } else if (!(m & 64)) (T += A[W + 2]), (T += I & $[m]), (W = (x + T) * 3), (m = A[W]);
            else
              return (
                (R.msg = 'invalid distance code'),
                (k = R.avail_in - P),
                (k = O >> 3 < k ? O >> 3 : k),
                (P += k),
                (N -= k),
                (O -= k << 3),
                (p.bitb = I),
                (p.bitk = O),
                (R.avail_in = P),
                (R.total_in += N - R.next_in_index),
                (R.next_in_index = N),
                (p.write = D),
                H
              );
          while (!0);
          break;
        }
        if (m & 64)
          return m & 32
            ? ((k = R.avail_in - P),
              (k = O >> 3 < k ? O >> 3 : k),
              (P += k),
              (N -= k),
              (O -= k << 3),
              (p.bitb = I),
              (p.bitk = O),
              (R.avail_in = P),
              (R.total_in += N - R.next_in_index),
              (R.next_in_index = N),
              (p.write = D),
              ee)
            : ((R.msg = 'invalid literal/length code'),
              (k = R.avail_in - P),
              (k = O >> 3 < k ? O >> 3 : k),
              (P += k),
              (N -= k),
              (O -= k << 3),
              (p.bitb = I),
              (p.bitk = O),
              (R.avail_in = P),
              (R.total_in += N - R.next_in_index),
              (R.next_in_index = N),
              (p.write = D),
              H);
        if (((T += A[W + 2]), (T += I & $[m]), (W = (x + T) * 3), (m = A[W]) === 0)) {
          (I >>= A[W + 1]), (O -= A[W + 1]), (p.win[D++] = A[W + 2]), M--;
          break;
        }
      } while (!0);
    } while (M >= 258 && P >= 10);
    return (
      (k = R.avail_in - P),
      (k = O >> 3 < k ? O >> 3 : k),
      (P += k),
      (N -= k),
      (O -= k << 3),
      (p.bitb = I),
      (p.bitk = O),
      (R.avail_in = P),
      (R.total_in += N - R.next_in_index),
      (R.next_in_index = N),
      (p.write = D),
      F
    );
  }
  (n.init = function (o, d, y, g, w, E) {
    (t = Ne), (_ = o), (f = d), (b = y), (h = g), (S = w), (C = E), (s = null);
  }),
    (n.proc = function (o, d, y) {
      let g,
        w,
        E,
        p = 0,
        R = 0,
        T = 0,
        A,
        x,
        m,
        I;
      for (
        T = d.next_in_index,
          A = d.avail_in,
          p = o.bitb,
          R = o.bitk,
          x = o.write,
          m = x < o.read ? o.read - x - 1 : o.end - x;
        ;

      )
        switch (t) {
          case Ne:
            if (
              m >= 258 &&
              A >= 10 &&
              ((o.bitb = p),
              (o.bitk = R),
              (d.avail_in = A),
              (d.total_in += T - d.next_in_index),
              (d.next_in_index = T),
              (o.write = x),
              (y = u(_, f, b, h, S, C, o, d)),
              (T = d.next_in_index),
              (A = d.avail_in),
              (p = o.bitb),
              (R = o.bitk),
              (x = o.write),
              (m = x < o.read ? o.read - x - 1 : o.end - x),
              y != F)
            ) {
              t = y == ee ? Xe : Le;
              break;
            }
            (i = _), (s = b), (r = h), (t = Ht);
          case Ht:
            for (g = i; R < g; ) {
              if (A !== 0) y = F;
              else
                return (
                  (o.bitb = p),
                  (o.bitk = R),
                  (d.avail_in = A),
                  (d.total_in += T - d.next_in_index),
                  (d.next_in_index = T),
                  (o.write = x),
                  o.inflate_flush(d, y)
                );
              A--, (p |= (d.read_byte(T++) & 255) << R), (R += 8);
            }
            if (
              ((w = (r + (p & $[g])) * 3), (p >>>= s[w + 1]), (R -= s[w + 1]), (E = s[w]), E === 0)
            ) {
              (a = s[w + 2]), (t = Gt);
              break;
            }
            if (E & 16) {
              (c = E & 15), (e = s[w + 2]), (t = Bt);
              break;
            }
            if (!(E & 64)) {
              (i = E), (r = w / 3 + s[w + 2]);
              break;
            }
            if (E & 32) {
              t = Xe;
              break;
            }
            return (
              (t = Le),
              (d.msg = 'invalid literal/length code'),
              (y = H),
              (o.bitb = p),
              (o.bitk = R),
              (d.avail_in = A),
              (d.total_in += T - d.next_in_index),
              (d.next_in_index = T),
              (o.write = x),
              o.inflate_flush(d, y)
            );
          case Bt:
            for (g = c; R < g; ) {
              if (A !== 0) y = F;
              else
                return (
                  (o.bitb = p),
                  (o.bitk = R),
                  (d.avail_in = A),
                  (d.total_in += T - d.next_in_index),
                  (d.next_in_index = T),
                  (o.write = x),
                  o.inflate_flush(d, y)
                );
              A--, (p |= (d.read_byte(T++) & 255) << R), (R += 8);
            }
            (e += p & $[g]), (p >>= g), (R -= g), (i = f), (s = S), (r = C), (t = jt);
          case jt:
            for (g = i; R < g; ) {
              if (A !== 0) y = F;
              else
                return (
                  (o.bitb = p),
                  (o.bitk = R),
                  (d.avail_in = A),
                  (d.total_in += T - d.next_in_index),
                  (d.next_in_index = T),
                  (o.write = x),
                  o.inflate_flush(d, y)
                );
              A--, (p |= (d.read_byte(T++) & 255) << R), (R += 8);
            }
            if (
              ((w = (r + (p & $[g])) * 3), (p >>= s[w + 1]), (R -= s[w + 1]), (E = s[w]), E & 16)
            ) {
              (c = E & 15), (l = s[w + 2]), (t = qt);
              break;
            }
            if (!(E & 64)) {
              (i = E), (r = w / 3 + s[w + 2]);
              break;
            }
            return (
              (t = Le),
              (d.msg = 'invalid distance code'),
              (y = H),
              (o.bitb = p),
              (o.bitk = R),
              (d.avail_in = A),
              (d.total_in += T - d.next_in_index),
              (d.next_in_index = T),
              (o.write = x),
              o.inflate_flush(d, y)
            );
          case qt:
            for (g = c; R < g; ) {
              if (A !== 0) y = F;
              else
                return (
                  (o.bitb = p),
                  (o.bitk = R),
                  (d.avail_in = A),
                  (d.total_in += T - d.next_in_index),
                  (d.next_in_index = T),
                  (o.write = x),
                  o.inflate_flush(d, y)
                );
              A--, (p |= (d.read_byte(T++) & 255) << R), (R += 8);
            }
            (l += p & $[g]), (p >>= g), (R -= g), (t = Yt);
          case Yt:
            for (I = x - l; I < 0; ) I += o.end;
            for (; e !== 0; ) {
              if (
                m === 0 &&
                (x == o.end &&
                  o.read !== 0 &&
                  ((x = 0), (m = x < o.read ? o.read - x - 1 : o.end - x)),
                m === 0 &&
                  ((o.write = x),
                  (y = o.inflate_flush(d, y)),
                  (x = o.write),
                  (m = x < o.read ? o.read - x - 1 : o.end - x),
                  x == o.end &&
                    o.read !== 0 &&
                    ((x = 0), (m = x < o.read ? o.read - x - 1 : o.end - x)),
                  m === 0))
              )
                return (
                  (o.bitb = p),
                  (o.bitk = R),
                  (d.avail_in = A),
                  (d.total_in += T - d.next_in_index),
                  (d.next_in_index = T),
                  (o.write = x),
                  o.inflate_flush(d, y)
                );
              (o.win[x++] = o.win[I++]), m--, I == o.end && (I = 0), e--;
            }
            t = Ne;
            break;
          case Gt:
            if (
              m === 0 &&
              (x == o.end &&
                o.read !== 0 &&
                ((x = 0), (m = x < o.read ? o.read - x - 1 : o.end - x)),
              m === 0 &&
                ((o.write = x),
                (y = o.inflate_flush(d, y)),
                (x = o.write),
                (m = x < o.read ? o.read - x - 1 : o.end - x),
                x == o.end &&
                  o.read !== 0 &&
                  ((x = 0), (m = x < o.read ? o.read - x - 1 : o.end - x)),
                m === 0))
            )
              return (
                (o.bitb = p),
                (o.bitk = R),
                (d.avail_in = A),
                (d.total_in += T - d.next_in_index),
                (d.next_in_index = T),
                (o.write = x),
                o.inflate_flush(d, y)
              );
            (y = F), (o.win[x++] = a), m--, (t = Ne);
            break;
          case Xe:
            if (
              (R > 7 && ((R -= 8), A++, T--),
              (o.write = x),
              (y = o.inflate_flush(d, y)),
              (x = o.write),
              (m = x < o.read ? o.read - x - 1 : o.end - x),
              o.read != o.write)
            )
              return (
                (o.bitb = p),
                (o.bitk = R),
                (d.avail_in = A),
                (d.total_in += T - d.next_in_index),
                (d.next_in_index = T),
                (o.write = x),
                o.inflate_flush(d, y)
              );
            t = Vt;
          case Vt:
            return (
              (y = ee),
              (o.bitb = p),
              (o.bitk = R),
              (d.avail_in = A),
              (d.total_in += T - d.next_in_index),
              (d.next_in_index = T),
              (o.write = x),
              o.inflate_flush(d, y)
            );
          case Le:
            return (
              (y = H),
              (o.bitb = p),
              (o.bitk = R),
              (d.avail_in = A),
              (d.total_in += T - d.next_in_index),
              (d.next_in_index = T),
              (o.write = x),
              o.inflate_flush(d, y)
            );
          default:
            return (
              (y = X),
              (o.bitb = p),
              (o.bitk = R),
              (d.avail_in = A),
              (d.total_in += T - d.next_in_index),
              (d.next_in_index = T),
              (o.write = x),
              o.inflate_flush(d, y)
            );
        }
    }),
    (n.free = function () {});
}
const Zt = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15],
  we = 0,
  $e = 1,
  Kt = 2,
  Xt = 3,
  $t = 4,
  Jt = 5,
  ve = 6,
  Fe = 7,
  Qt = 8,
  he = 9;
function Tr(n, t) {
  const e = this;
  let s = we,
    r = 0,
    i = 0,
    a = 0,
    c;
  const l = [0],
    _ = [0],
    f = new Er();
  let b = 0,
    h = new Int32Array(Mn * 3);
  const S = 0,
    C = new at();
  (e.bitk = 0),
    (e.bitb = 0),
    (e.win = new Uint8Array(t)),
    (e.end = t),
    (e.read = 0),
    (e.write = 0),
    (e.reset = function (u, o) {
      o && (o[0] = S),
        s == ve && f.free(u),
        (s = we),
        (e.bitk = 0),
        (e.bitb = 0),
        (e.read = e.write = 0);
    }),
    e.reset(n, null),
    (e.inflate_flush = function (u, o) {
      let d, y, g;
      return (
        (y = u.next_out_index),
        (g = e.read),
        (d = (g <= e.write ? e.write : e.end) - g),
        d > u.avail_out && (d = u.avail_out),
        d !== 0 && o == te && (o = F),
        (u.avail_out -= d),
        (u.total_out += d),
        u.next_out.set(e.win.subarray(g, g + d), y),
        (y += d),
        (g += d),
        g == e.end &&
          ((g = 0),
          e.write == e.end && (e.write = 0),
          (d = e.write - g),
          d > u.avail_out && (d = u.avail_out),
          d !== 0 && o == te && (o = F),
          (u.avail_out -= d),
          (u.total_out += d),
          u.next_out.set(e.win.subarray(g, g + d), y),
          (y += d),
          (g += d)),
        (u.next_out_index = y),
        (e.read = g),
        o
      );
    }),
    (e.proc = function (u, o) {
      let d, y, g, w, E, p, R, T;
      for (
        w = u.next_in_index,
          E = u.avail_in,
          y = e.bitb,
          g = e.bitk,
          p = e.write,
          R = p < e.read ? e.read - p - 1 : e.end - p;
        ;

      ) {
        let A, x, m, I, O, N, P, D;
        switch (s) {
          case we:
            for (; g < 3; ) {
              if (E !== 0) o = F;
              else
                return (
                  (e.bitb = y),
                  (e.bitk = g),
                  (u.avail_in = E),
                  (u.total_in += w - u.next_in_index),
                  (u.next_in_index = w),
                  (e.write = p),
                  e.inflate_flush(u, o)
                );
              E--, (y |= (u.read_byte(w++) & 255) << g), (g += 8);
            }
            switch (((d = y & 7), (b = d & 1), d >>> 1)) {
              case 0:
                (y >>>= 3), (g -= 3), (d = g & 7), (y >>>= d), (g -= d), (s = $e);
                break;
              case 1:
                (A = []),
                  (x = []),
                  (m = [[]]),
                  (I = [[]]),
                  at.inflate_trees_fixed(A, x, m, I),
                  f.init(A[0], x[0], m[0], 0, I[0], 0),
                  (y >>>= 3),
                  (g -= 3),
                  (s = ve);
                break;
              case 2:
                (y >>>= 3), (g -= 3), (s = Xt);
                break;
              case 3:
                return (
                  (y >>>= 3),
                  (g -= 3),
                  (s = he),
                  (u.msg = 'invalid block type'),
                  (o = H),
                  (e.bitb = y),
                  (e.bitk = g),
                  (u.avail_in = E),
                  (u.total_in += w - u.next_in_index),
                  (u.next_in_index = w),
                  (e.write = p),
                  e.inflate_flush(u, o)
                );
            }
            break;
          case $e:
            for (; g < 32; ) {
              if (E !== 0) o = F;
              else
                return (
                  (e.bitb = y),
                  (e.bitk = g),
                  (u.avail_in = E),
                  (u.total_in += w - u.next_in_index),
                  (u.next_in_index = w),
                  (e.write = p),
                  e.inflate_flush(u, o)
                );
              E--, (y |= (u.read_byte(w++) & 255) << g), (g += 8);
            }
            if (((~y >>> 16) & 65535) != (y & 65535))
              return (
                (s = he),
                (u.msg = 'invalid stored block lengths'),
                (o = H),
                (e.bitb = y),
                (e.bitk = g),
                (u.avail_in = E),
                (u.total_in += w - u.next_in_index),
                (u.next_in_index = w),
                (e.write = p),
                e.inflate_flush(u, o)
              );
            (r = y & 65535), (y = g = 0), (s = r !== 0 ? Kt : b !== 0 ? Fe : we);
            break;
          case Kt:
            if (
              E === 0 ||
              (R === 0 &&
                (p == e.end &&
                  e.read !== 0 &&
                  ((p = 0), (R = p < e.read ? e.read - p - 1 : e.end - p)),
                R === 0 &&
                  ((e.write = p),
                  (o = e.inflate_flush(u, o)),
                  (p = e.write),
                  (R = p < e.read ? e.read - p - 1 : e.end - p),
                  p == e.end &&
                    e.read !== 0 &&
                    ((p = 0), (R = p < e.read ? e.read - p - 1 : e.end - p)),
                  R === 0)))
            )
              return (
                (e.bitb = y),
                (e.bitk = g),
                (u.avail_in = E),
                (u.total_in += w - u.next_in_index),
                (u.next_in_index = w),
                (e.write = p),
                e.inflate_flush(u, o)
              );
            if (
              ((o = F),
              (d = r),
              d > E && (d = E),
              d > R && (d = R),
              e.win.set(u.read_buf(w, d), p),
              (w += d),
              (E -= d),
              (p += d),
              (R -= d),
              (r -= d) !== 0)
            )
              break;
            s = b !== 0 ? Fe : we;
            break;
          case Xt:
            for (; g < 14; ) {
              if (E !== 0) o = F;
              else
                return (
                  (e.bitb = y),
                  (e.bitk = g),
                  (u.avail_in = E),
                  (u.total_in += w - u.next_in_index),
                  (u.next_in_index = w),
                  (e.write = p),
                  e.inflate_flush(u, o)
                );
              E--, (y |= (u.read_byte(w++) & 255) << g), (g += 8);
            }
            if (((i = d = y & 16383), (d & 31) > 29 || ((d >> 5) & 31) > 29))
              return (
                (s = he),
                (u.msg = 'too many length or distance symbols'),
                (o = H),
                (e.bitb = y),
                (e.bitk = g),
                (u.avail_in = E),
                (u.total_in += w - u.next_in_index),
                (u.next_in_index = w),
                (e.write = p),
                e.inflate_flush(u, o)
              );
            if (((d = 258 + (d & 31) + ((d >> 5) & 31)), !c || c.length < d)) c = [];
            else for (T = 0; T < d; T++) c[T] = 0;
            (y >>>= 14), (g -= 14), (a = 0), (s = $t);
          case $t:
            for (; a < 4 + (i >>> 10); ) {
              for (; g < 3; ) {
                if (E !== 0) o = F;
                else
                  return (
                    (e.bitb = y),
                    (e.bitk = g),
                    (u.avail_in = E),
                    (u.total_in += w - u.next_in_index),
                    (u.next_in_index = w),
                    (e.write = p),
                    e.inflate_flush(u, o)
                  );
                E--, (y |= (u.read_byte(w++) & 255) << g), (g += 8);
              }
              (c[Zt[a++]] = y & 7), (y >>>= 3), (g -= 3);
            }
            for (; a < 19; ) c[Zt[a++]] = 0;
            if (((l[0] = 7), (d = C.inflate_trees_bits(c, l, _, h, u)), d != F))
              return (
                (o = d),
                o == H && ((c = null), (s = he)),
                (e.bitb = y),
                (e.bitk = g),
                (u.avail_in = E),
                (u.total_in += w - u.next_in_index),
                (u.next_in_index = w),
                (e.write = p),
                e.inflate_flush(u, o)
              );
            (a = 0), (s = Jt);
          case Jt:
            for (; (d = i), !(a >= 258 + (d & 31) + ((d >> 5) & 31)); ) {
              let M, L;
              for (d = l[0]; g < d; ) {
                if (E !== 0) o = F;
                else
                  return (
                    (e.bitb = y),
                    (e.bitk = g),
                    (u.avail_in = E),
                    (u.total_in += w - u.next_in_index),
                    (u.next_in_index = w),
                    (e.write = p),
                    e.inflate_flush(u, o)
                  );
                E--, (y |= (u.read_byte(w++) & 255) << g), (g += 8);
              }
              if (
                ((d = h[(_[0] + (y & $[d])) * 3 + 1]), (L = h[(_[0] + (y & $[d])) * 3 + 2]), L < 16)
              )
                (y >>>= d), (g -= d), (c[a++] = L);
              else {
                for (T = L == 18 ? 7 : L - 14, M = L == 18 ? 11 : 3; g < d + T; ) {
                  if (E !== 0) o = F;
                  else
                    return (
                      (e.bitb = y),
                      (e.bitk = g),
                      (u.avail_in = E),
                      (u.total_in += w - u.next_in_index),
                      (u.next_in_index = w),
                      (e.write = p),
                      e.inflate_flush(u, o)
                    );
                  E--, (y |= (u.read_byte(w++) & 255) << g), (g += 8);
                }
                if (
                  ((y >>>= d),
                  (g -= d),
                  (M += y & $[T]),
                  (y >>>= T),
                  (g -= T),
                  (T = a),
                  (d = i),
                  T + M > 258 + (d & 31) + ((d >> 5) & 31) || (L == 16 && T < 1))
                )
                  return (
                    (c = null),
                    (s = he),
                    (u.msg = 'invalid bit length repeat'),
                    (o = H),
                    (e.bitb = y),
                    (e.bitk = g),
                    (u.avail_in = E),
                    (u.total_in += w - u.next_in_index),
                    (u.next_in_index = w),
                    (e.write = p),
                    e.inflate_flush(u, o)
                  );
                L = L == 16 ? c[T - 1] : 0;
                do c[T++] = L;
                while (--M !== 0);
                a = T;
              }
            }
            if (
              ((_[0] = -1),
              (O = []),
              (N = []),
              (P = []),
              (D = []),
              (O[0] = 9),
              (N[0] = 6),
              (d = i),
              (d = C.inflate_trees_dynamic(
                257 + (d & 31),
                1 + ((d >> 5) & 31),
                c,
                O,
                N,
                P,
                D,
                h,
                u
              )),
              d != F)
            )
              return (
                d == H && ((c = null), (s = he)),
                (o = d),
                (e.bitb = y),
                (e.bitk = g),
                (u.avail_in = E),
                (u.total_in += w - u.next_in_index),
                (u.next_in_index = w),
                (e.write = p),
                e.inflate_flush(u, o)
              );
            f.init(O[0], N[0], h, P[0], h, D[0]), (s = ve);
          case ve:
            if (
              ((e.bitb = y),
              (e.bitk = g),
              (u.avail_in = E),
              (u.total_in += w - u.next_in_index),
              (u.next_in_index = w),
              (e.write = p),
              (o = f.proc(e, u, o)) != ee)
            )
              return e.inflate_flush(u, o);
            if (
              ((o = F),
              f.free(u),
              (w = u.next_in_index),
              (E = u.avail_in),
              (y = e.bitb),
              (g = e.bitk),
              (p = e.write),
              (R = p < e.read ? e.read - p - 1 : e.end - p),
              b === 0)
            ) {
              s = we;
              break;
            }
            s = Fe;
          case Fe:
            if (
              ((e.write = p),
              (o = e.inflate_flush(u, o)),
              (p = e.write),
              (R = p < e.read ? e.read - p - 1 : e.end - p),
              e.read != e.write)
            )
              return (
                (e.bitb = y),
                (e.bitk = g),
                (u.avail_in = E),
                (u.total_in += w - u.next_in_index),
                (u.next_in_index = w),
                (e.write = p),
                e.inflate_flush(u, o)
              );
            s = Qt;
          case Qt:
            return (
              (o = ee),
              (e.bitb = y),
              (e.bitk = g),
              (u.avail_in = E),
              (u.total_in += w - u.next_in_index),
              (u.next_in_index = w),
              (e.write = p),
              e.inflate_flush(u, o)
            );
          case he:
            return (
              (o = H),
              (e.bitb = y),
              (e.bitk = g),
              (u.avail_in = E),
              (u.total_in += w - u.next_in_index),
              (u.next_in_index = w),
              (e.write = p),
              e.inflate_flush(u, o)
            );
          default:
            return (
              (o = X),
              (e.bitb = y),
              (e.bitk = g),
              (u.avail_in = E),
              (u.total_in += w - u.next_in_index),
              (u.next_in_index = w),
              (e.write = p),
              e.inflate_flush(u, o)
            );
        }
      }
    }),
    (e.free = function (u) {
      e.reset(u, null), (e.win = null), (h = null);
    }),
    (e.set_dictionary = function (u, o, d) {
      e.win.set(u.subarray(o, o + d), 0), (e.read = e.write = d);
    }),
    (e.sync_point = function () {
      return s == $e ? 1 : 0;
    });
}
const Sr = 32,
  Rr = 8,
  Ar = 0,
  zt = 1,
  en = 2,
  tn = 3,
  nn = 4,
  sn = 5,
  Je = 6,
  xe = 7,
  rn = 12,
  se = 13,
  Cr = [0, 0, 255, 255];
function Or() {
  const n = this;
  (n.mode = 0), (n.method = 0), (n.was = [0]), (n.need = 0), (n.marker = 0), (n.wbits = 0);
  function t(e) {
    return !e || !e.istate
      ? X
      : ((e.total_in = e.total_out = 0),
        (e.msg = null),
        (e.istate.mode = xe),
        e.istate.blocks.reset(e, null),
        F);
  }
  (n.inflateEnd = function (e) {
    return n.blocks && n.blocks.free(e), (n.blocks = null), F;
  }),
    (n.inflateInit = function (e, s) {
      return (
        (e.msg = null),
        (n.blocks = null),
        s < 8 || s > 15
          ? (n.inflateEnd(e), X)
          : ((n.wbits = s), (e.istate.blocks = new Tr(e, 1 << s)), t(e), F)
      );
    }),
    (n.inflate = function (e, s) {
      let r, i;
      if (!e || !e.istate || !e.next_in) return X;
      const a = e.istate;
      for (s = s == _r ? te : F, r = te; ; )
        switch (a.mode) {
          case Ar:
            if (e.avail_in === 0) return r;
            if (
              ((r = s),
              e.avail_in--,
              e.total_in++,
              ((a.method = e.read_byte(e.next_in_index++)) & 15) != Rr)
            ) {
              (a.mode = se), (e.msg = 'unknown compression method'), (a.marker = 5);
              break;
            }
            if ((a.method >> 4) + 8 > a.wbits) {
              (a.mode = se), (e.msg = 'invalid win size'), (a.marker = 5);
              break;
            }
            a.mode = zt;
          case zt:
            if (e.avail_in === 0) return r;
            if (
              ((r = s),
              e.avail_in--,
              e.total_in++,
              (i = e.read_byte(e.next_in_index++) & 255),
              ((a.method << 8) + i) % 31 !== 0)
            ) {
              (a.mode = se), (e.msg = 'incorrect header check'), (a.marker = 5);
              break;
            }
            if (!(i & Sr)) {
              a.mode = xe;
              break;
            }
            a.mode = en;
          case en:
            if (e.avail_in === 0) return r;
            (r = s),
              e.avail_in--,
              e.total_in++,
              (a.need = ((e.read_byte(e.next_in_index++) & 255) << 24) & 4278190080),
              (a.mode = tn);
          case tn:
            if (e.avail_in === 0) return r;
            (r = s),
              e.avail_in--,
              e.total_in++,
              (a.need += ((e.read_byte(e.next_in_index++) & 255) << 16) & 16711680),
              (a.mode = nn);
          case nn:
            if (e.avail_in === 0) return r;
            (r = s),
              e.avail_in--,
              e.total_in++,
              (a.need += ((e.read_byte(e.next_in_index++) & 255) << 8) & 65280),
              (a.mode = sn);
          case sn:
            return e.avail_in === 0
              ? r
              : ((r = s),
                e.avail_in--,
                e.total_in++,
                (a.need += e.read_byte(e.next_in_index++) & 255),
                (a.mode = Je),
                ur);
          case Je:
            return (a.mode = se), (e.msg = 'need dictionary'), (a.marker = 0), X;
          case xe:
            if (((r = a.blocks.proc(e, r)), r == H)) {
              (a.mode = se), (a.marker = 0);
              break;
            }
            if ((r == F && (r = s), r != ee)) return r;
            (r = s), a.blocks.reset(e, a.was), (a.mode = rn);
          case rn:
            return (e.avail_in = 0), ee;
          case se:
            return H;
          default:
            return X;
        }
    }),
    (n.inflateSetDictionary = function (e, s, r) {
      let i = 0,
        a = r;
      if (!e || !e.istate || e.istate.mode != Je) return X;
      const c = e.istate;
      return (
        a >= 1 << c.wbits && ((a = (1 << c.wbits) - 1), (i = r - a)),
        c.blocks.set_dictionary(s, i, a),
        (c.mode = xe),
        F
      );
    }),
    (n.inflateSync = function (e) {
      let s, r, i, a, c;
      if (!e || !e.istate) return X;
      const l = e.istate;
      if ((l.mode != se && ((l.mode = se), (l.marker = 0)), (s = e.avail_in) === 0)) return te;
      for (r = e.next_in_index, i = l.marker; s !== 0 && i < 4; )
        e.read_byte(r) == Cr[i] ? i++ : e.read_byte(r) !== 0 ? (i = 0) : (i = 4 - i), r++, s--;
      return (
        (e.total_in += r - e.next_in_index),
        (e.next_in_index = r),
        (e.avail_in = s),
        (l.marker = i),
        i != 4
          ? H
          : ((a = e.total_in),
            (c = e.total_out),
            t(e),
            (e.total_in = a),
            (e.total_out = c),
            (l.mode = xe),
            F)
      );
    }),
    (n.inflateSyncPoint = function (e) {
      return !e || !e.istate || !e.istate.blocks ? X : e.istate.blocks.sync_point();
    });
}
function Wn() {}
Wn.prototype = {
  inflateInit(n) {
    const t = this;
    return (t.istate = new Or()), n || (n = fr), t.istate.inflateInit(t, n);
  },
  inflate(n) {
    const t = this;
    return t.istate ? t.istate.inflate(t, n) : X;
  },
  inflateEnd() {
    const n = this;
    if (!n.istate) return X;
    const t = n.istate.inflateEnd(n);
    return (n.istate = null), t;
  },
  inflateSync() {
    const n = this;
    return n.istate ? n.istate.inflateSync(n) : X;
  },
  inflateSetDictionary(n, t) {
    const e = this;
    return e.istate ? e.istate.inflateSetDictionary(e, n, t) : X;
  },
  read_byte(n) {
    return this.next_in[n];
  },
  read_buf(n, t) {
    return this.next_in.subarray(n, n + t);
  },
};
function Ir(n) {
  const t = this,
    e = new Wn(),
    s = n && n.chunkSize ? Math.floor(n.chunkSize * 2) : 128 * 1024,
    r = dr,
    i = new Uint8Array(s);
  let a = !1;
  e.inflateInit(),
    (e.next_out = i),
    (t.append = function (c, l) {
      const _ = [];
      let f,
        b,
        h = 0,
        S = 0,
        C = 0;
      if (c.length !== 0) {
        (e.next_in_index = 0), (e.next_in = c), (e.avail_in = c.length);
        do {
          if (
            ((e.next_out_index = 0),
            (e.avail_out = s),
            e.avail_in === 0 && !a && ((e.next_in_index = 0), (a = !0)),
            (f = e.inflate(r)),
            a && f === te)
          ) {
            if (e.avail_in !== 0) throw new Error('inflating: bad input');
          } else if (f !== F && f !== ee) throw new Error('inflating: ' + e.msg);
          if ((a || f === ee) && e.avail_in === c.length) throw new Error('inflating: bad input');
          e.next_out_index &&
            (e.next_out_index === s
              ? _.push(new Uint8Array(i))
              : _.push(i.subarray(0, e.next_out_index))),
            (C += e.next_out_index),
            l &&
              e.next_in_index > 0 &&
              e.next_in_index != h &&
              (l(e.next_in_index), (h = e.next_in_index));
        } while (e.avail_in > 0 || e.avail_out === 0);
        return (
          _.length > 1
            ? ((b = new Uint8Array(C)),
              _.forEach(function (u) {
                b.set(u, S), (S += u.length);
              }))
            : (b = _[0] ? new Uint8Array(_[0]) : new Uint8Array()),
          b
        );
      }
    }),
    (t.flush = function () {
      e.inflateEnd();
    });
}
const pe = 4294967295,
  ae = 65535,
  Pr = 8,
  Dr = 0,
  kr = 99,
  Nr = 67324752,
  Lr = 134695760,
  an = 33639248,
  vr = 101010256,
  on = 101075792,
  Fr = 117853008,
  oe = 22,
  Qe = 20,
  ze = 56,
  Ur = 1,
  Mr = 39169,
  Wr = 10,
  Hr = 1,
  Br = 21589,
  jr = 28789,
  qr = 25461,
  Yr = 6534,
  cn = 1,
  Gr = 6,
  ln = 8,
  fn = 2048,
  un = 16,
  dn = 16384,
  _n = 73,
  hn = '/',
  V = void 0,
  ue = 'undefined',
  Ie = 'function';
class pn {
  constructor(t) {
    return class extends TransformStream {
      constructor(e, s) {
        const r = new t(s);
        super({
          transform(i, a) {
            a.enqueue(r.append(i));
          },
          flush(i) {
            const a = r.flush();
            a && i.enqueue(a);
          },
        });
      }
    };
  }
}
const Vr = 64;
let Hn = 2;
try {
  typeof navigator != ue && navigator.hardwareConcurrency && (Hn = navigator.hardwareConcurrency);
} catch {}
const Zr = {
    chunkSize: 512 * 1024,
    maxWorkers: Hn,
    terminateWorkerTimeout: 5e3,
    useWebWorkers: !0,
    useCompressionStream: !0,
    workerScripts: V,
    CompressionStreamNative: typeof CompressionStream != ue && CompressionStream,
    DecompressionStreamNative: typeof DecompressionStream != ue && DecompressionStream,
  },
  ce = Object.assign({}, Zr);
function Bn() {
  return ce;
}
function Kr(n) {
  return Math.max(n.chunkSize, Vr);
}
function jn(n) {
  const {
    baseURL: t,
    chunkSize: e,
    maxWorkers: s,
    terminateWorkerTimeout: r,
    useCompressionStream: i,
    useWebWorkers: a,
    Deflate: c,
    Inflate: l,
    CompressionStream: _,
    DecompressionStream: f,
    workerScripts: b,
  } = n;
  if (
    (re('baseURL', t),
    re('chunkSize', e),
    re('maxWorkers', s),
    re('terminateWorkerTimeout', r),
    re('useCompressionStream', i),
    re('useWebWorkers', a),
    c && (ce.CompressionStream = new pn(c)),
    l && (ce.DecompressionStream = new pn(l)),
    re('CompressionStream', _),
    re('DecompressionStream', f),
    b !== V)
  ) {
    const { deflate: h, inflate: S } = b;
    if (((h || S) && (ce.workerScripts || (ce.workerScripts = {})), h)) {
      if (!Array.isArray(h)) throw new Error('workerScripts.deflate must be an array');
      ce.workerScripts.deflate = h;
    }
    if (S) {
      if (!Array.isArray(S)) throw new Error('workerScripts.inflate must be an array');
      ce.workerScripts.inflate = S;
    }
  }
}
function re(n, t) {
  t !== V && (ce[n] = t);
}
function Xr() {
  return 'application/octet-stream';
}
const qn = [];
for (let n = 0; n < 256; n++) {
  let t = n;
  for (let e = 0; e < 8; e++) t & 1 ? (t = (t >>> 1) ^ 3988292384) : (t = t >>> 1);
  qn[n] = t;
}
class Be {
  constructor(t) {
    this.crc = t || -1;
  }
  append(t) {
    let e = this.crc | 0;
    for (let s = 0, r = t.length | 0; s < r; s++) e = (e >>> 8) ^ qn[(e ^ t[s]) & 255];
    this.crc = e;
  }
  get() {
    return ~this.crc;
  }
}
class Yn extends TransformStream {
  constructor() {
    let t;
    const e = new Be();
    super({
      transform(s, r) {
        e.append(s), r.enqueue(s);
      },
      flush() {
        const s = new Uint8Array(4);
        new DataView(s.buffer).setUint32(0, e.get()), (t.value = s);
      },
    }),
      (t = this);
  }
}
function $r(n) {
  if (typeof TextEncoder == ue) {
    n = unescape(encodeURIComponent(n));
    const t = new Uint8Array(n.length);
    for (let e = 0; e < t.length; e++) t[e] = n.charCodeAt(e);
    return t;
  } else return new TextEncoder().encode(n);
}
const K = {
    concat(n, t) {
      if (n.length === 0 || t.length === 0) return n.concat(t);
      const e = n[n.length - 1],
        s = K.getPartial(e);
      return s === 32 ? n.concat(t) : K._shiftRight(t, s, e | 0, n.slice(0, n.length - 1));
    },
    bitLength(n) {
      const t = n.length;
      if (t === 0) return 0;
      const e = n[t - 1];
      return (t - 1) * 32 + K.getPartial(e);
    },
    clamp(n, t) {
      if (n.length * 32 < t) return n;
      n = n.slice(0, Math.ceil(t / 32));
      const e = n.length;
      return (
        (t = t & 31),
        e > 0 && t && (n[e - 1] = K.partial(t, n[e - 1] & (2147483648 >> (t - 1)), 1)),
        n
      );
    },
    partial(n, t, e) {
      return n === 32 ? t : (e ? t | 0 : t << (32 - n)) + n * 1099511627776;
    },
    getPartial(n) {
      return Math.round(n / 1099511627776) || 32;
    },
    _shiftRight(n, t, e, s) {
      for (s === void 0 && (s = []); t >= 32; t -= 32) s.push(e), (e = 0);
      if (t === 0) return s.concat(n);
      for (let a = 0; a < n.length; a++) s.push(e | (n[a] >>> t)), (e = n[a] << (32 - t));
      const r = n.length ? n[n.length - 1] : 0,
        i = K.getPartial(r);
      return s.push(K.partial((t + i) & 31, t + i > 32 ? e : s.pop(), 1)), s;
    },
  },
  je = {
    bytes: {
      fromBits(n) {
        const e = K.bitLength(n) / 8,
          s = new Uint8Array(e);
        let r;
        for (let i = 0; i < e; i++) i & 3 || (r = n[i / 4]), (s[i] = r >>> 24), (r <<= 8);
        return s;
      },
      toBits(n) {
        const t = [];
        let e,
          s = 0;
        for (e = 0; e < n.length; e++) (s = (s << 8) | n[e]), (e & 3) === 3 && (t.push(s), (s = 0));
        return e & 3 && t.push(K.partial(8 * (e & 3), s)), t;
      },
    },
  },
  Gn = {};
Gn.sha1 = class {
  constructor(n) {
    const t = this;
    (t.blockSize = 512),
      (t._init = [1732584193, 4023233417, 2562383102, 271733878, 3285377520]),
      (t._key = [1518500249, 1859775393, 2400959708, 3395469782]),
      n
        ? ((t._h = n._h.slice(0)), (t._buffer = n._buffer.slice(0)), (t._length = n._length))
        : t.reset();
  }
  reset() {
    const n = this;
    return (n._h = n._init.slice(0)), (n._buffer = []), (n._length = 0), n;
  }
  update(n) {
    const t = this;
    typeof n == 'string' && (n = je.utf8String.toBits(n));
    const e = (t._buffer = K.concat(t._buffer, n)),
      s = t._length,
      r = (t._length = s + K.bitLength(n));
    if (r > 9007199254740991) throw new Error('Cannot hash more than 2^53 - 1 bits');
    const i = new Uint32Array(e);
    let a = 0;
    for (
      let c = t.blockSize + s - ((t.blockSize + s) & (t.blockSize - 1));
      c <= r;
      c += t.blockSize
    )
      t._block(i.subarray(16 * a, 16 * (a + 1))), (a += 1);
    return e.splice(0, 16 * a), t;
  }
  finalize() {
    const n = this;
    let t = n._buffer;
    const e = n._h;
    t = K.concat(t, [K.partial(1, 1)]);
    for (let s = t.length + 2; s & 15; s++) t.push(0);
    for (t.push(Math.floor(n._length / 4294967296)), t.push(n._length | 0); t.length; )
      n._block(t.splice(0, 16));
    return n.reset(), e;
  }
  _f(n, t, e, s) {
    if (n <= 19) return (t & e) | (~t & s);
    if (n <= 39) return t ^ e ^ s;
    if (n <= 59) return (t & e) | (t & s) | (e & s);
    if (n <= 79) return t ^ e ^ s;
  }
  _S(n, t) {
    return (t << n) | (t >>> (32 - n));
  }
  _block(n) {
    const t = this,
      e = t._h,
      s = Array(80);
    for (let _ = 0; _ < 16; _++) s[_] = n[_];
    let r = e[0],
      i = e[1],
      a = e[2],
      c = e[3],
      l = e[4];
    for (let _ = 0; _ <= 79; _++) {
      _ >= 16 && (s[_] = t._S(1, s[_ - 3] ^ s[_ - 8] ^ s[_ - 14] ^ s[_ - 16]));
      const f = (t._S(5, r) + t._f(_, i, a, c) + l + s[_] + t._key[Math.floor(_ / 20)]) | 0;
      (l = c), (c = a), (a = t._S(30, i)), (i = r), (r = f);
    }
    (e[0] = (e[0] + r) | 0),
      (e[1] = (e[1] + i) | 0),
      (e[2] = (e[2] + a) | 0),
      (e[3] = (e[3] + c) | 0),
      (e[4] = (e[4] + l) | 0);
  }
};
const Vn = {};
Vn.aes = class {
  constructor(n) {
    const t = this;
    (t._tables = [
      [[], [], [], [], []],
      [[], [], [], [], []],
    ]),
      t._tables[0][0][0] || t._precompute();
    const e = t._tables[0][4],
      s = t._tables[1],
      r = n.length;
    let i,
      a,
      c,
      l = 1;
    if (r !== 4 && r !== 6 && r !== 8) throw new Error('invalid aes key size');
    for (t._key = [(a = n.slice(0)), (c = [])], i = r; i < 4 * r + 28; i++) {
      let _ = a[i - 1];
      (i % r === 0 || (r === 8 && i % r === 4)) &&
        ((_ =
          (e[_ >>> 24] << 24) ^ (e[(_ >> 16) & 255] << 16) ^ (e[(_ >> 8) & 255] << 8) ^ e[_ & 255]),
        i % r === 0 &&
          ((_ = (_ << 8) ^ (_ >>> 24) ^ (l << 24)), (l = (l << 1) ^ ((l >> 7) * 283)))),
        (a[i] = a[i - r] ^ _);
    }
    for (let _ = 0; i; _++, i--) {
      const f = a[_ & 3 ? i : i - 4];
      i <= 4 || _ < 4
        ? (c[_] = f)
        : (c[_] =
            s[0][e[f >>> 24]] ^
            s[1][e[(f >> 16) & 255]] ^
            s[2][e[(f >> 8) & 255]] ^
            s[3][e[f & 255]]);
    }
  }
  encrypt(n) {
    return this._crypt(n, 0);
  }
  decrypt(n) {
    return this._crypt(n, 1);
  }
  _precompute() {
    const n = this._tables[0],
      t = this._tables[1],
      e = n[4],
      s = t[4],
      r = [],
      i = [];
    let a, c, l, _;
    for (let f = 0; f < 256; f++) i[(r[f] = (f << 1) ^ ((f >> 7) * 283)) ^ f] = f;
    for (let f = (a = 0); !e[f]; f ^= c || 1, a = i[a] || 1) {
      let b = a ^ (a << 1) ^ (a << 2) ^ (a << 3) ^ (a << 4);
      (b = (b >> 8) ^ (b & 255) ^ 99), (e[f] = b), (s[b] = f), (_ = r[(l = r[(c = r[f])])]);
      let h = (_ * 16843009) ^ (l * 65537) ^ (c * 257) ^ (f * 16843008),
        S = (r[b] * 257) ^ (b * 16843008);
      for (let C = 0; C < 4; C++)
        (n[C][f] = S = (S << 24) ^ (S >>> 8)), (t[C][b] = h = (h << 24) ^ (h >>> 8));
    }
    for (let f = 0; f < 5; f++) (n[f] = n[f].slice(0)), (t[f] = t[f].slice(0));
  }
  _crypt(n, t) {
    if (n.length !== 4) throw new Error('invalid aes block size');
    const e = this._key[t],
      s = e.length / 4 - 2,
      r = [0, 0, 0, 0],
      i = this._tables[t],
      a = i[0],
      c = i[1],
      l = i[2],
      _ = i[3],
      f = i[4];
    let b = n[0] ^ e[0],
      h = n[t ? 3 : 1] ^ e[1],
      S = n[2] ^ e[2],
      C = n[t ? 1 : 3] ^ e[3],
      u = 4,
      o,
      d,
      y;
    for (let g = 0; g < s; g++)
      (o = a[b >>> 24] ^ c[(h >> 16) & 255] ^ l[(S >> 8) & 255] ^ _[C & 255] ^ e[u]),
        (d = a[h >>> 24] ^ c[(S >> 16) & 255] ^ l[(C >> 8) & 255] ^ _[b & 255] ^ e[u + 1]),
        (y = a[S >>> 24] ^ c[(C >> 16) & 255] ^ l[(b >> 8) & 255] ^ _[h & 255] ^ e[u + 2]),
        (C = a[C >>> 24] ^ c[(b >> 16) & 255] ^ l[(h >> 8) & 255] ^ _[S & 255] ^ e[u + 3]),
        (u += 4),
        (b = o),
        (h = d),
        (S = y);
    for (let g = 0; g < 4; g++)
      (r[t ? 3 & -g : g] =
        (f[b >>> 24] << 24) ^
        (f[(h >> 16) & 255] << 16) ^
        (f[(S >> 8) & 255] << 8) ^
        f[C & 255] ^
        e[u++]),
        (o = b),
        (b = h),
        (h = S),
        (S = C),
        (C = o);
    return r;
  }
};
const Jr = {
    getRandomValues(n) {
      const t = new Uint32Array(n.buffer),
        e = (s) => {
          let r = 987654321;
          const i = 4294967295;
          return function () {
            return (
              (r = (36969 * (r & 65535) + (r >> 16)) & i),
              (s = (18e3 * (s & 65535) + (s >> 16)) & i),
              ((((r << 16) + s) & i) / 4294967296 + 0.5) * (Math.random() > 0.5 ? 1 : -1)
            );
          };
        };
      for (let s = 0, r; s < n.length; s += 4) {
        const i = e((r || Math.random()) * 4294967296);
        (r = i() * 987654071), (t[s / 4] = (i() * 4294967296) | 0);
      }
      return n;
    },
  },
  Zn = {};
Zn.ctrGladman = class {
  constructor(n, t) {
    (this._prf = n), (this._initIv = t), (this._iv = t);
  }
  reset() {
    this._iv = this._initIv;
  }
  update(n) {
    return this.calculate(this._prf, n, this._iv);
  }
  incWord(n) {
    if (((n >> 24) & 255) === 255) {
      let t = (n >> 16) & 255,
        e = (n >> 8) & 255,
        s = n & 255;
      t === 255 ? ((t = 0), e === 255 ? ((e = 0), s === 255 ? (s = 0) : ++s) : ++e) : ++t,
        (n = 0),
        (n += t << 16),
        (n += e << 8),
        (n += s);
    } else n += 1 << 24;
    return n;
  }
  incCounter(n) {
    (n[0] = this.incWord(n[0])) === 0 && (n[1] = this.incWord(n[1]));
  }
  calculate(n, t, e) {
    let s;
    if (!(s = t.length)) return [];
    const r = K.bitLength(t);
    for (let i = 0; i < s; i += 4) {
      this.incCounter(e);
      const a = n.encrypt(e);
      (t[i] ^= a[0]), (t[i + 1] ^= a[1]), (t[i + 2] ^= a[2]), (t[i + 3] ^= a[3]);
    }
    return K.clamp(t, r);
  }
};
const me = {
  importKey(n) {
    return new me.hmacSha1(je.bytes.toBits(n));
  },
  pbkdf2(n, t, e, s) {
    if (((e = e || 1e4), s < 0 || e < 0)) throw new Error('invalid params to pbkdf2');
    const r = ((s >> 5) + 1) << 2;
    let i, a, c, l, _;
    const f = new ArrayBuffer(r),
      b = new DataView(f);
    let h = 0;
    const S = K;
    for (t = je.bytes.toBits(t), _ = 1; h < (r || 1); _++) {
      for (i = a = n.encrypt(S.concat(t, [_])), c = 1; c < e; c++)
        for (a = n.encrypt(a), l = 0; l < a.length; l++) i[l] ^= a[l];
      for (c = 0; h < (r || 1) && c < i.length; c++) b.setInt32(h, i[c]), (h += 4);
    }
    return f.slice(0, s / 8);
  },
};
me.hmacSha1 = class {
  constructor(n) {
    const t = this,
      e = (t._hash = Gn.sha1),
      s = [[], []];
    t._baseHash = [new e(), new e()];
    const r = t._baseHash[0].blockSize / 32;
    n.length > r && (n = new e().update(n).finalize());
    for (let i = 0; i < r; i++) (s[0][i] = n[i] ^ 909522486), (s[1][i] = n[i] ^ 1549556828);
    t._baseHash[0].update(s[0]),
      t._baseHash[1].update(s[1]),
      (t._resultHash = new e(t._baseHash[0]));
  }
  reset() {
    const n = this;
    (n._resultHash = new n._hash(n._baseHash[0])), (n._updated = !1);
  }
  update(n) {
    const t = this;
    (t._updated = !0), t._resultHash.update(n);
  }
  digest() {
    const n = this,
      t = n._resultHash.finalize(),
      e = new n._hash(n._baseHash[1]).update(t).finalize();
    return n.reset(), e;
  }
  encrypt(n) {
    if (this._updated) throw new Error('encrypt on already updated hmac called!');
    return this.update(n), this.digest(n);
  }
};
const Qr = typeof crypto != ue && typeof crypto.getRandomValues == Ie,
  mt = 'Invalid password',
  wt = 'Invalid signature',
  gt = 'zipjs-abort-check-password';
function Kn(n) {
  return Qr ? crypto.getRandomValues(n) : Jr.getRandomValues(n);
}
const ge = 16,
  zr = 'raw',
  Xn = { name: 'PBKDF2' },
  ei = { name: 'HMAC' },
  ti = 'SHA-1',
  ni = Object.assign({ hash: ei }, Xn),
  ot = Object.assign({ iterations: 1e3, hash: { name: ti } }, Xn),
  si = ['deriveBits'],
  Se = [8, 12, 16],
  Ee = [16, 24, 32],
  ie = 10,
  ri = [0, 0, 0, 0],
  Ye = typeof crypto != ue,
  Pe = Ye && crypto.subtle,
  $n = Ye && typeof Pe != ue,
  Q = je.bytes,
  ii = Vn.aes,
  ai = Zn.ctrGladman,
  oi = me.hmacSha1;
let mn = Ye && $n && typeof Pe.importKey == Ie,
  wn = Ye && $n && typeof Pe.deriveBits == Ie;
class ci extends TransformStream {
  constructor({
    password: t,
    rawPassword: e,
    signed: s,
    encryptionStrength: r,
    checkPasswordOnly: i,
  }) {
    super({
      start() {
        Object.assign(this, {
          ready: new Promise((a) => (this.resolveReady = a)),
          password: zn(t, e),
          signed: s,
          strength: r - 1,
          pending: new Uint8Array(),
        });
      },
      async transform(a, c) {
        const l = this,
          { password: _, strength: f, resolveReady: b, ready: h } = l;
        _
          ? (await fi(l, f, _, J(a, 0, Se[f] + 2)),
            (a = J(a, Se[f] + 2)),
            i ? c.error(new Error(gt)) : b())
          : await h;
        const S = new Uint8Array(a.length - ie - ((a.length - ie) % ge));
        c.enqueue(Jn(l, a, S, 0, ie, !0));
      },
      async flush(a) {
        const { signed: c, ctr: l, hmac: _, pending: f, ready: b } = this;
        if (_ && l) {
          await b;
          const h = J(f, 0, f.length - ie),
            S = J(f, f.length - ie);
          let C = new Uint8Array();
          if (h.length) {
            const u = Ae(Q, h);
            _.update(u);
            const o = l.update(u);
            C = Re(Q, o);
          }
          if (c) {
            const u = J(Re(Q, _.digest()), 0, ie);
            for (let o = 0; o < ie; o++) if (u[o] != S[o]) throw new Error(wt);
          }
          a.enqueue(C);
        }
      },
    });
  }
}
class li extends TransformStream {
  constructor({ password: t, rawPassword: e, encryptionStrength: s }) {
    let r;
    super({
      start() {
        Object.assign(this, {
          ready: new Promise((i) => (this.resolveReady = i)),
          password: zn(t, e),
          strength: s - 1,
          pending: new Uint8Array(),
        });
      },
      async transform(i, a) {
        const c = this,
          { password: l, strength: _, resolveReady: f, ready: b } = c;
        let h = new Uint8Array();
        l ? ((h = await ui(c, _, l)), f()) : await b;
        const S = new Uint8Array(h.length + i.length - (i.length % ge));
        S.set(h, 0), a.enqueue(Jn(c, i, S, h.length, 0));
      },
      async flush(i) {
        const { ctr: a, hmac: c, pending: l, ready: _ } = this;
        if (c && a) {
          await _;
          let f = new Uint8Array();
          if (l.length) {
            const b = a.update(Ae(Q, l));
            c.update(b), (f = Re(Q, b));
          }
          (r.signature = Re(Q, c.digest()).slice(0, ie)), i.enqueue(bt(f, r.signature));
        }
      },
    }),
      (r = this);
  }
}
function Jn(n, t, e, s, r, i) {
  const { ctr: a, hmac: c, pending: l } = n,
    _ = t.length - r;
  l.length && ((t = bt(l, t)), (e = hi(e, _ - (_ % ge))));
  let f;
  for (f = 0; f <= _ - ge; f += ge) {
    const b = Ae(Q, J(t, f, f + ge));
    i && c.update(b);
    const h = a.update(b);
    i || c.update(h), e.set(Re(Q, h), f + s);
  }
  return (n.pending = J(t, f)), e;
}
async function fi(n, t, e, s) {
  const r = await Qn(n, t, e, J(s, 0, Se[t])),
    i = J(s, Se[t]);
  if (r[0] != i[0] || r[1] != i[1]) throw new Error(mt);
}
async function ui(n, t, e) {
  const s = Kn(new Uint8Array(Se[t])),
    r = await Qn(n, t, e, s);
  return bt(s, r);
}
async function Qn(n, t, e, s) {
  n.password = null;
  const r = await di(zr, e, ni, !1, si),
    i = await _i(Object.assign({ salt: s }, ot), r, 8 * (Ee[t] * 2 + 2)),
    a = new Uint8Array(i),
    c = Ae(Q, J(a, 0, Ee[t])),
    l = Ae(Q, J(a, Ee[t], Ee[t] * 2)),
    _ = J(a, Ee[t] * 2);
  return (
    Object.assign(n, {
      keys: { key: c, authentication: l, passwordVerification: _ },
      ctr: new ai(new ii(c), Array.from(ri)),
      hmac: new oi(l),
    }),
    _
  );
}
async function di(n, t, e, s, r) {
  if (mn)
    try {
      return await Pe.importKey(n, t, e, s, r);
    } catch {
      return (mn = !1), me.importKey(t);
    }
  else return me.importKey(t);
}
async function _i(n, t, e) {
  if (wn)
    try {
      return await Pe.deriveBits(n, t, e);
    } catch {
      return (wn = !1), me.pbkdf2(t, n.salt, ot.iterations, e);
    }
  else return me.pbkdf2(t, n.salt, ot.iterations, e);
}
function zn(n, t) {
  return t === V ? $r(n) : t;
}
function bt(n, t) {
  let e = n;
  return (
    n.length + t.length &&
      ((e = new Uint8Array(n.length + t.length)), e.set(n, 0), e.set(t, n.length)),
    e
  );
}
function hi(n, t) {
  if (t && t > n.length) {
    const e = n;
    (n = new Uint8Array(t)), n.set(e, 0);
  }
  return n;
}
function J(n, t, e) {
  return n.subarray(t, e);
}
function Re(n, t) {
  return n.fromBits(t);
}
function Ae(n, t) {
  return n.toBits(t);
}
const be = 12;
class pi extends TransformStream {
  constructor({ password: t, passwordVerification: e, checkPasswordOnly: s }) {
    super({
      start() {
        Object.assign(this, { password: t, passwordVerification: e }), es(this, t);
      },
      transform(r, i) {
        const a = this;
        if (a.password) {
          const c = gn(a, r.subarray(0, be));
          if (((a.password = null), c[be - 1] != a.passwordVerification)) throw new Error(mt);
          r = r.subarray(be);
        }
        s ? i.error(new Error(gt)) : i.enqueue(gn(a, r));
      },
    });
  }
}
class mi extends TransformStream {
  constructor({ password: t, passwordVerification: e }) {
    super({
      start() {
        Object.assign(this, { password: t, passwordVerification: e }), es(this, t);
      },
      transform(s, r) {
        const i = this;
        let a, c;
        if (i.password) {
          i.password = null;
          const l = Kn(new Uint8Array(be));
          (l[be - 1] = i.passwordVerification),
            (a = new Uint8Array(s.length + l.length)),
            a.set(bn(i, l), 0),
            (c = be);
        } else (a = new Uint8Array(s.length)), (c = 0);
        a.set(bn(i, s), c), r.enqueue(a);
      },
    });
  }
}
function gn(n, t) {
  const e = new Uint8Array(t.length);
  for (let s = 0; s < t.length; s++) (e[s] = ts(n) ^ t[s]), yt(n, e[s]);
  return e;
}
function bn(n, t) {
  const e = new Uint8Array(t.length);
  for (let s = 0; s < t.length; s++) (e[s] = ts(n) ^ t[s]), yt(n, t[s]);
  return e;
}
function es(n, t) {
  const e = [305419896, 591751049, 878082192];
  Object.assign(n, { keys: e, crcKey0: new Be(e[0]), crcKey2: new Be(e[2]) });
  for (let s = 0; s < t.length; s++) yt(n, t.charCodeAt(s));
}
function yt(n, t) {
  let [e, s, r] = n.keys;
  n.crcKey0.append([t]),
    (e = ~n.crcKey0.get()),
    (s = yn(Math.imul(yn(s + ns(e)), 134775813) + 1)),
    n.crcKey2.append([s >>> 24]),
    (r = ~n.crcKey2.get()),
    (n.keys = [e, s, r]);
}
function ts(n) {
  const t = n.keys[2] | 2;
  return ns(Math.imul(t, t ^ 1) >>> 8);
}
function ns(n) {
  return n & 255;
}
function yn(n) {
  return n & 4294967295;
}
const xn = 'deflate-raw';
class wi extends TransformStream {
  constructor(t, { chunkSize: e, CompressionStream: s, CompressionStreamNative: r }) {
    super({});
    const {
        compressed: i,
        encrypted: a,
        useCompressionStream: c,
        zipCrypto: l,
        signed: _,
        level: f,
      } = t,
      b = this;
    let h,
      S,
      C = ss(super.readable);
    (!a || l) && _ && ((h = new Yn()), (C = z(C, h))),
      i && (C = is(C, c, { level: f, chunkSize: e }, r, s)),
      a && (l ? (C = z(C, new mi(t))) : ((S = new li(t)), (C = z(C, S)))),
      rs(b, C, () => {
        let u;
        a && !l && (u = S.signature),
          (!a || l) && _ && (u = new DataView(h.value.buffer).getUint32(0)),
          (b.signature = u);
      });
  }
}
class gi extends TransformStream {
  constructor(t, { chunkSize: e, DecompressionStream: s, DecompressionStreamNative: r }) {
    super({});
    const {
      zipCrypto: i,
      encrypted: a,
      signed: c,
      signature: l,
      compressed: _,
      useCompressionStream: f,
    } = t;
    let b,
      h,
      S = ss(super.readable);
    a && (i ? (S = z(S, new pi(t))) : ((h = new ci(t)), (S = z(S, h)))),
      _ && (S = is(S, f, { chunkSize: e }, r, s)),
      (!a || i) && c && ((b = new Yn()), (S = z(S, b))),
      rs(this, S, () => {
        if ((!a || i) && c) {
          const C = new DataView(b.value.buffer);
          if (l != C.getUint32(0, !1)) throw new Error(wt);
        }
      });
  }
}
function ss(n) {
  return z(
    n,
    new TransformStream({
      transform(t, e) {
        t && t.length && e.enqueue(t);
      },
    })
  );
}
function rs(n, t, e) {
  (t = z(t, new TransformStream({ flush: e }))),
    Object.defineProperty(n, 'readable', {
      get() {
        return t;
      },
    });
}
function is(n, t, e, s, r) {
  try {
    const i = t && s ? s : r;
    n = z(n, new i(xn, e));
  } catch {
    if (t)
      try {
        n = z(n, new r(xn, e));
      } catch {
        return n;
      }
    else return n;
  }
  return n;
}
function z(n, t) {
  return n.pipeThrough(t);
}
const bi = 'message',
  yi = 'start',
  xi = 'pull',
  En = 'data',
  Ei = 'ack',
  Tn = 'close',
  Ti = 'deflate',
  as = 'inflate';
class Si extends TransformStream {
  constructor(t, e) {
    super({});
    const s = this,
      { codecType: r } = t;
    let i;
    r.startsWith(Ti) ? (i = wi) : r.startsWith(as) && (i = gi);
    let a = 0,
      c = 0;
    const l = new i(t, e),
      _ = super.readable,
      f = new TransformStream({
        transform(h, S) {
          h && h.length && ((c += h.length), S.enqueue(h));
        },
        flush() {
          Object.assign(s, { inputSize: c });
        },
      }),
      b = new TransformStream({
        transform(h, S) {
          h && h.length && ((a += h.length), S.enqueue(h));
        },
        flush() {
          const { signature: h } = l;
          Object.assign(s, { signature: h, outputSize: a, inputSize: c });
        },
      });
    Object.defineProperty(s, 'readable', {
      get() {
        return _.pipeThrough(f).pipeThrough(l).pipeThrough(b);
      },
    });
  }
}
class Ri extends TransformStream {
  constructor(t) {
    let e;
    super({
      transform: s,
      flush(r) {
        e && e.length && r.enqueue(e);
      },
    });
    function s(r, i) {
      if (e) {
        const a = new Uint8Array(e.length + r.length);
        a.set(e), a.set(r, e.length), (r = a), (e = null);
      }
      r.length > t ? (i.enqueue(r.slice(0, t)), s(r.slice(t), i)) : (e = r);
    }
  }
}
let os = typeof Worker != ue;
class et {
  constructor(
    t,
    { readable: e, writable: s },
    { options: r, config: i, streamOptions: a, useWebWorkers: c, transferStreams: l, scripts: _ },
    f
  ) {
    const { signal: b } = a;
    return (
      Object.assign(t, {
        busy: !0,
        readable: e.pipeThrough(new Ri(i.chunkSize)).pipeThrough(new Ai(e, a), { signal: b }),
        writable: s,
        options: Object.assign({}, r),
        scripts: _,
        transferStreams: l,
        terminate() {
          return new Promise((h) => {
            const { worker: S, busy: C } = t;
            S ? (C ? (t.resolveTerminated = h) : (S.terminate(), h()), (t.interface = null)) : h();
          });
        },
        onTaskFinished() {
          const { resolveTerminated: h } = t;
          h && ((t.resolveTerminated = null), (t.terminated = !0), t.worker.terminate(), h()),
            (t.busy = !1),
            f(t);
        },
      }),
      (c && os ? Ci : cs)(t, i)
    );
  }
}
class Ai extends TransformStream {
  constructor(t, { onstart: e, onprogress: s, size: r, onend: i }) {
    let a = 0;
    super({
      async start() {
        e && (await tt(e, r));
      },
      async transform(c, l) {
        (a += c.length), s && (await tt(s, a, r)), l.enqueue(c);
      },
      async flush() {
        (t.size = a), i && (await tt(i, a));
      },
    });
  }
}
async function tt(n, ...t) {
  try {
    await n(...t);
  } catch {}
}
function cs(n, t) {
  return { run: () => Oi(n, t) };
}
function Ci(n, t) {
  const { baseURL: e, chunkSize: s } = t;
  if (!n.interface) {
    let r;
    try {
      r = Di(n.scripts[0], e, n);
    } catch {
      return (os = !1), cs(n, t);
    }
    Object.assign(n, { worker: r, interface: { run: () => Ii(n, { chunkSize: s }) } });
  }
  return n.interface;
}
async function Oi({ options: n, readable: t, writable: e, onTaskFinished: s }, r) {
  try {
    const i = new Si(n, r);
    await t.pipeThrough(i).pipeTo(e, { preventClose: !0, preventAbort: !0 });
    const { signature: a, inputSize: c, outputSize: l } = i;
    return { signature: a, inputSize: c, outputSize: l };
  } finally {
    s();
  }
}
async function Ii(n, t) {
  let e, s;
  const r = new Promise((h, S) => {
    (e = h), (s = S);
  });
  Object.assign(n, { reader: null, writer: null, resolveResult: e, rejectResult: s, result: r });
  const { readable: i, options: a, scripts: c } = n,
    { writable: l, closed: _ } = Pi(n.writable),
    f = Ue({ type: yi, scripts: c.slice(1), options: a, config: t, readable: i, writable: l }, n);
  f || Object.assign(n, { reader: i.getReader(), writer: l.getWriter() });
  const b = await r;
  return f || (await l.getWriter().close()), await _, b;
}
function Pi(n) {
  let t;
  const e = new Promise((r) => (t = r));
  return {
    writable: new WritableStream({
      async write(r) {
        const i = n.getWriter();
        await i.ready, await i.write(r), i.releaseLock();
      },
      close() {
        t();
      },
      abort(r) {
        return n.getWriter().abort(r);
      },
    }),
    closed: e,
  };
}
let Sn = !0,
  Rn = !0;
function Di(n, t, e) {
  const s = { type: 'module' };
  let r, i;
  typeof n == Ie && (n = n());
  try {
    r = new URL(n, t);
  } catch {
    r = n;
  }
  if (Sn)
    try {
      i = new Worker(r);
    } catch {
      (Sn = !1), (i = new Worker(r, s));
    }
  else i = new Worker(r, s);
  return i.addEventListener(bi, (a) => ki(a, e)), i;
}
function Ue(n, { worker: t, writer: e, onTaskFinished: s, transferStreams: r }) {
  try {
    const { value: i, readable: a, writable: c } = n,
      l = [];
    if (
      (i &&
        (i.byteLength < i.buffer.byteLength
          ? (n.value = i.buffer.slice(0, i.byteLength))
          : (n.value = i.buffer),
        l.push(n.value)),
      r && Rn ? (a && l.push(a), c && l.push(c)) : (n.readable = n.writable = null),
      l.length)
    )
      try {
        return t.postMessage(n, l), !0;
      } catch {
        (Rn = !1), (n.readable = n.writable = null), t.postMessage(n);
      }
    else t.postMessage(n);
  } catch (i) {
    throw (e && e.releaseLock(), s(), i);
  }
}
async function ki({ data: n }, t) {
  const { type: e, value: s, messageId: r, result: i, error: a } = n,
    { reader: c, writer: l, resolveResult: _, rejectResult: f, onTaskFinished: b } = t;
  try {
    if (a) {
      const { message: S, stack: C, code: u, name: o } = a,
        d = new Error(S);
      Object.assign(d, { stack: C, code: u, name: o }), h(d);
    } else {
      if (e == xi) {
        const { value: S, done: C } = await c.read();
        Ue({ type: En, value: S, done: C, messageId: r }, t);
      }
      e == En &&
        (await l.ready, await l.write(new Uint8Array(s)), Ue({ type: Ei, messageId: r }, t)),
        e == Tn && h(null, i);
    }
  } catch (S) {
    Ue({ type: Tn, messageId: r }, t), h(S);
  }
  function h(S, C) {
    S ? f(S) : _(C), l && l.releaseLock(), b();
  }
}
let le = [];
const nt = [];
let An = 0;
async function Ni(n, t) {
  const { options: e, config: s } = t,
    {
      transferStreams: r,
      useWebWorkers: i,
      useCompressionStream: a,
      codecType: c,
      compressed: l,
      signed: _,
      encrypted: f,
    } = e,
    { workerScripts: b, maxWorkers: h } = s;
  t.transferStreams = r || r === V;
  const S = !l && !_ && !f && !t.transferStreams;
  return (
    (t.useWebWorkers = !S && (i || (i === V && s.useWebWorkers))),
    (t.scripts = t.useWebWorkers && b ? b[c] : []),
    (e.useCompressionStream = a || (a === V && s.useCompressionStream)),
    (await C()).run()
  );
  async function C() {
    const o = le.find((d) => !d.busy);
    if (o) return ct(o), new et(o, n, t, u);
    if (le.length < h) {
      const d = { indexWorker: An };
      return An++, le.push(d), new et(d, n, t, u);
    } else return new Promise((d) => nt.push({ resolve: d, stream: n, workerOptions: t }));
  }
  function u(o) {
    if (nt.length) {
      const [{ resolve: d, stream: y, workerOptions: g }] = nt.splice(0, 1);
      d(new et(o, y, g, u));
    } else o.worker ? (ct(o), Li(o, t)) : (le = le.filter((d) => d != o));
  }
}
function Li(n, t) {
  const { config: e } = t,
    { terminateWorkerTimeout: s } = e;
  Number.isFinite(s) &&
    s >= 0 &&
    (n.terminated
      ? (n.terminated = !1)
      : (n.terminateTimeout = setTimeout(async () => {
          le = le.filter((r) => r != n);
          try {
            await n.terminate();
          } catch {}
        }, s)));
}
function ct(n) {
  const { terminateTimeout: t } = n;
  t && (clearTimeout(t), (n.terminateTimeout = null));
}
async function vi() {
  await Promise.allSettled(le.map((n) => (ct(n), n.terminate())));
}
const ls = 'HTTP error ',
  De = 'HTTP Range not supported',
  fs = 'Writer iterator completed too soon',
  Fi = 'text/plain',
  Ui = 'Content-Length',
  Mi = 'Content-Range',
  Wi = 'Accept-Ranges',
  Hi = 'Range',
  Bi = 'Content-Type',
  ji = 'HEAD',
  xt = 'GET',
  us = 'bytes',
  qi = 64 * 1024,
  Et = 'writable';
class Ge {
  constructor() {
    this.size = 0;
  }
  init() {
    this.initialized = !0;
  }
}
class de extends Ge {
  get readable() {
    const t = this,
      { chunkSize: e = qi } = t,
      s = new ReadableStream({
        start() {
          this.chunkOffset = 0;
        },
        async pull(r) {
          const { offset: i = 0, size: a, diskNumberStart: c } = s,
            { chunkOffset: l } = this;
          r.enqueue(await G(t, i + l, Math.min(e, a - l), c)),
            l + e > a ? r.close() : (this.chunkOffset += e);
        },
      });
    return s;
  }
}
class Tt extends Ge {
  constructor() {
    super();
    const t = this,
      e = new WritableStream({
        write(s) {
          return t.writeUint8Array(s);
        },
      });
    Object.defineProperty(t, Et, {
      get() {
        return e;
      },
    });
  }
  writeUint8Array() {}
}
class Yi extends de {
  constructor(t) {
    super();
    let e = t.length;
    for (; t.charAt(e - 1) == '='; ) e--;
    const s = t.indexOf(',') + 1;
    Object.assign(this, { dataURI: t, dataStart: s, size: Math.floor((e - s) * 0.75) });
  }
  readUint8Array(t, e) {
    const { dataStart: s, dataURI: r } = this,
      i = new Uint8Array(e),
      a = Math.floor(t / 3) * 4,
      c = atob(r.substring(a + s, Math.ceil((t + e) / 3) * 4 + s)),
      l = t - Math.floor(a / 4) * 3;
    for (let _ = l; _ < l + e; _++) i[_ - l] = c.charCodeAt(_);
    return i;
  }
}
class Gi extends Tt {
  constructor(t) {
    super(), Object.assign(this, { data: 'data:' + (t || '') + ';base64,', pending: [] });
  }
  writeUint8Array(t) {
    const e = this;
    let s = 0,
      r = e.pending;
    const i = e.pending.length;
    for (e.pending = '', s = 0; s < Math.floor((i + t.length) / 3) * 3 - i; s++)
      r += String.fromCharCode(t[s]);
    for (; s < t.length; s++) e.pending += String.fromCharCode(t[s]);
    r.length > 2 ? (e.data += btoa(r)) : (e.pending = r);
  }
  getData() {
    return this.data + btoa(this.pending);
  }
}
class St extends de {
  constructor(t) {
    super(), Object.assign(this, { blob: t, size: t.size });
  }
  async readUint8Array(t, e) {
    const s = this,
      r = t + e;
    let a = await (t || r < s.size ? s.blob.slice(t, r) : s.blob).arrayBuffer();
    return a.byteLength > e && (a = a.slice(t, r)), new Uint8Array(a);
  }
}
class ds extends Ge {
  constructor(t) {
    super();
    const e = this,
      s = new TransformStream(),
      r = [];
    t && r.push([Bi, t]),
      Object.defineProperty(e, Et, {
        get() {
          return s.writable;
        },
      }),
      (e.blob = new Response(s.readable, { headers: r }).blob());
  }
  getData() {
    return this.blob;
  }
}
class Vi extends St {
  constructor(t) {
    super(new Blob([t], { type: Fi }));
  }
}
class Zi extends ds {
  constructor(t) {
    super(t), Object.assign(this, { encoding: t, utf8: !t || t.toLowerCase() == 'utf-8' });
  }
  async getData() {
    const { encoding: t, utf8: e } = this,
      s = await super.getData();
    if (s.text && e) return s.text();
    {
      const r = new FileReader();
      return new Promise((i, a) => {
        Object.assign(r, { onload: ({ target: c }) => i(c.result), onerror: () => a(r.error) }),
          r.readAsText(s, t);
      });
    }
  }
}
class Ki extends de {
  constructor(t, e) {
    super(), _s(this, t, e);
  }
  async init() {
    await hs(this, lt, Cn), super.init();
  }
  readUint8Array(t, e) {
    return ps(this, t, e, lt, Cn);
  }
}
class Xi extends de {
  constructor(t, e) {
    super(), _s(this, t, e);
  }
  async init() {
    await hs(this, ft, On), super.init();
  }
  readUint8Array(t, e) {
    return ps(this, t, e, ft, On);
  }
}
function _s(n, t, e) {
  const { preventHeadRequest: s, useRangeHeader: r, forceRangeRequests: i, combineSizeEocd: a } = e;
  (e = Object.assign({}, e)),
    delete e.preventHeadRequest,
    delete e.useRangeHeader,
    delete e.forceRangeRequests,
    delete e.combineSizeEocd,
    delete e.useXHR,
    Object.assign(n, {
      url: t,
      options: e,
      preventHeadRequest: s,
      useRangeHeader: r,
      forceRangeRequests: i,
      combineSizeEocd: a,
    });
}
async function hs(n, t, e) {
  const {
    url: s,
    preventHeadRequest: r,
    useRangeHeader: i,
    forceRangeRequests: a,
    combineSizeEocd: c,
  } = n;
  if (zi(s) && (i || a) && (typeof r > 'u' || r)) {
    const l = await t(xt, n, ms(n, c ? -22 : void 0));
    if (!a && l.headers.get(Wi) != us) throw new Error(De);
    {
      c && (n.eocdCache = new Uint8Array(await l.arrayBuffer()));
      let _;
      const f = l.headers.get(Mi);
      if (f) {
        const b = f.trim().split(/\s*\/\s*/);
        if (b.length) {
          const h = b[1];
          h && h != '*' && (_ = Number(h));
        }
      }
      _ === V ? await In(n, t, e) : (n.size = _);
    }
  } else await In(n, t, e);
}
async function ps(n, t, e, s, r) {
  const { useRangeHeader: i, forceRangeRequests: a, eocdCache: c, size: l, options: _ } = n;
  if (i || a) {
    if (c && t == l - oe && e == oe) return c;
    const f = await s(xt, n, ms(n, t, e));
    if (f.status != 206) throw new Error(De);
    return new Uint8Array(await f.arrayBuffer());
  } else {
    const { data: f } = n;
    return f || (await r(n, _)), new Uint8Array(n.data.subarray(t, t + e));
  }
}
function ms(n, t = 0, e = 1) {
  return Object.assign({}, Rt(n), { [Hi]: us + '=' + (t < 0 ? t : t + '-' + (t + e - 1)) });
}
function Rt({ options: n }) {
  const { headers: t } = n;
  if (t) return Symbol.iterator in t ? Object.fromEntries(t) : t;
}
async function Cn(n) {
  await ws(n, lt);
}
async function On(n) {
  await ws(n, ft);
}
async function ws(n, t) {
  const e = await t(xt, n, Rt(n));
  (n.data = new Uint8Array(await e.arrayBuffer())), n.size || (n.size = n.data.length);
}
async function In(n, t, e) {
  if (n.preventHeadRequest) await e(n, n.options);
  else {
    const r = (await t(ji, n, Rt(n))).headers.get(Ui);
    r ? (n.size = Number(r)) : await e(n, n.options);
  }
}
async function lt(n, { options: t, url: e }, s) {
  const r = await fetch(e, Object.assign({}, t, { method: n, headers: s }));
  if (r.status < 400) return r;
  throw r.status == 416 ? new Error(De) : new Error(ls + (r.statusText || r.status));
}
function ft(n, { url: t }, e) {
  return new Promise((s, r) => {
    const i = new XMLHttpRequest();
    if (
      (i.addEventListener(
        'load',
        () => {
          if (i.status < 400) {
            const a = [];
            i
              .getAllResponseHeaders()
              .trim()
              .split(/[\r\n]+/)
              .forEach((c) => {
                const l = c.trim().split(/\s*:\s*/);
                (l[0] = l[0].trim().replace(/^[a-z]|-[a-z]/g, (_) => _.toUpperCase())), a.push(l);
              }),
              s({ status: i.status, arrayBuffer: () => i.response, headers: new Map(a) });
          } else r(i.status == 416 ? new Error(De) : new Error(ls + (i.statusText || i.status)));
        },
        !1
      ),
      i.addEventListener(
        'error',
        (a) => r(a.detail ? a.detail.error : new Error('Network error')),
        !1
      ),
      i.open(n, t),
      e)
    )
      for (const a of Object.entries(e)) i.setRequestHeader(a[0], a[1]);
    (i.responseType = 'arraybuffer'), i.send();
  });
}
class gs extends de {
  constructor(t, e = {}) {
    super(), Object.assign(this, { url: t, reader: e.useXHR ? new Xi(t, e) : new Ki(t, e) });
  }
  set size(t) {}
  get size() {
    return this.reader.size;
  }
  async init() {
    await this.reader.init(), super.init();
  }
  readUint8Array(t, e) {
    return this.reader.readUint8Array(t, e);
  }
}
class $i extends gs {
  constructor(t, e = {}) {
    (e.useRangeHeader = !0), super(t, e);
  }
}
class Ji extends de {
  constructor(t) {
    super(), Object.assign(this, { array: t, size: t.length });
  }
  readUint8Array(t, e) {
    return this.array.slice(t, t + e);
  }
}
class Qi extends Tt {
  init(t = 0) {
    Object.assign(this, { offset: 0, array: new Uint8Array(t) }), super.init();
  }
  writeUint8Array(t) {
    const e = this;
    if (e.offset + t.length > e.array.length) {
      const s = e.array;
      (e.array = new Uint8Array(s.length + t.length)), e.array.set(s);
    }
    e.array.set(t, e.offset), (e.offset += t.length);
  }
  getData() {
    return this.array;
  }
}
class At extends de {
  constructor(t) {
    super(), (this.readers = t);
  }
  async init() {
    const t = this,
      { readers: e } = t;
    (t.lastDiskNumber = 0),
      (t.lastDiskOffset = 0),
      await Promise.all(
        e.map(async (s, r) => {
          await s.init(), r != e.length - 1 && (t.lastDiskOffset += s.size), (t.size += s.size);
        })
      ),
      super.init();
  }
  async readUint8Array(t, e, s = 0) {
    const r = this,
      { readers: i } = this;
    let a,
      c = s;
    c == -1 && (c = i.length - 1);
    let l = t;
    for (; l >= i[c].size; ) (l -= i[c].size), c++;
    const _ = i[c],
      f = _.size;
    if (l + e <= f) a = await G(_, l, e);
    else {
      const b = f - l;
      (a = new Uint8Array(e)),
        a.set(await G(_, l, b)),
        a.set(await r.readUint8Array(t + b, e - b, s), b);
    }
    return (r.lastDiskNumber = Math.max(c, r.lastDiskNumber)), a;
  }
}
class qe extends Ge {
  constructor(t, e = 4294967295) {
    super();
    const s = this;
    Object.assign(s, { diskNumber: 0, diskOffset: 0, size: 0, maxSize: e, availableSize: e });
    let r, i, a;
    const c = new WritableStream({
      async write(f) {
        const { availableSize: b } = s;
        if (a)
          f.length >= b
            ? (await l(f.slice(0, b)),
              await _(),
              (s.diskOffset += r.size),
              s.diskNumber++,
              (a = null),
              await this.write(f.slice(b)))
            : await l(f);
        else {
          const { value: h, done: S } = await t.next();
          if (S && !h) throw new Error(fs);
          (r = h),
            (r.size = 0),
            r.maxSize && (s.maxSize = r.maxSize),
            (s.availableSize = s.maxSize),
            await Ce(r),
            (i = h.writable),
            (a = i.getWriter()),
            await this.write(f);
        }
      },
      async close() {
        await a.ready, await _();
      },
    });
    Object.defineProperty(s, Et, {
      get() {
        return c;
      },
    });
    async function l(f) {
      const b = f.length;
      b && (await a.ready, await a.write(f), (r.size += b), (s.size += b), (s.availableSize -= b));
    }
    async function _() {
      (i.size = r.size), await a.close();
    }
  }
}
function zi(n) {
  const { baseURL: t } = Bn(),
    { protocol: e } = new URL(n, t);
  return e == 'http:' || e == 'https:';
}
async function Ce(n, t) {
  if (n.init && !n.initialized) await n.init(t);
  else return Promise.resolve();
}
function bs(n) {
  return (
    Array.isArray(n) && (n = new At(n)), n instanceof ReadableStream && (n = { readable: n }), n
  );
}
function ys(n) {
  n.writable === V && typeof n.next == Ie && (n = new qe(n)),
    n instanceof WritableStream && (n = { writable: n });
  const { writable: t } = n;
  return (
    t.size === V && (t.size = 0),
    n instanceof qe ||
      Object.assign(n, { diskNumber: 0, diskOffset: 0, availableSize: 1 / 0, maxSize: 1 / 0 }),
    n
  );
}
function G(n, t, e, s) {
  return n.readUint8Array(t, e, s);
}
const ea = At,
  ta = qe,
  xs =
    '\0☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '.split(
      ''
    ),
  na = xs.length == 256;
function sa(n) {
  if (na) {
    let t = '';
    for (let e = 0; e < n.length; e++) t += xs[n[e]];
    return t;
  } else return new TextDecoder().decode(n);
}
function Me(n, t) {
  return t && t.trim().toLowerCase() == 'cp437' ? sa(n) : new TextDecoder(t).decode(n);
}
const Es = 'filename',
  Ts = 'rawFilename',
  Ss = 'comment',
  Rs = 'rawComment',
  As = 'uncompressedSize',
  Cs = 'compressedSize',
  Os = 'offset',
  ut = 'diskNumberStart',
  dt = 'lastModDate',
  _t = 'rawLastModDate',
  Is = 'lastAccessDate',
  ra = 'rawLastAccessDate',
  Ps = 'creationDate',
  ia = 'rawCreationDate',
  aa = 'internalFileAttribute',
  oa = 'internalFileAttributes',
  ca = 'externalFileAttribute',
  la = 'externalFileAttributes',
  fa = 'msDosCompatible',
  ua = 'zip64',
  da = 'encrypted',
  _a = 'version',
  ha = 'versionMadeBy',
  pa = 'zipCrypto',
  ma = 'directory',
  wa = 'executable',
  ga = [
    Es,
    Ts,
    Cs,
    As,
    dt,
    _t,
    Ss,
    Rs,
    Is,
    Ps,
    Os,
    ut,
    ut,
    aa,
    oa,
    ca,
    la,
    fa,
    ua,
    da,
    _a,
    ha,
    pa,
    ma,
    wa,
    'bitFlag',
    'signature',
    'filenameUTF8',
    'commentUTF8',
    'compressionMethod',
    'extraField',
    'rawExtraField',
    'extraFieldZip64',
    'extraFieldUnicodePath',
    'extraFieldUnicodeComment',
    'extraFieldAES',
    'extraFieldNTFS',
    'extraFieldExtendedTimestamp',
  ];
class Pn {
  constructor(t) {
    ga.forEach((e) => (this[e] = t[e]));
  }
}
const We = 'File format is not recognized',
  Ds = 'End of central directory not found',
  ks = 'End of Zip64 central directory locator not found',
  Ns = 'Central directory header not found',
  Ls = 'Local file header not found',
  vs = 'Zip64 extra field not found',
  Fs = 'File contains encrypted entry',
  Us = 'Encryption method not supported',
  ht = 'Compression method not supported',
  pt = 'Split zip file',
  Dn = 'utf-8',
  kn = 'cp437',
  ba = [
    [As, pe],
    [Cs, pe],
    [Os, pe],
    [ut, ae],
  ],
  ya = { [ae]: { getValue: B, bytes: 4 }, [pe]: { getValue: He, bytes: 8 } };
class Ms {
  constructor(t, e = {}) {
    Object.assign(this, { reader: bs(t), options: e, config: Bn() });
  }
  async *getEntriesGenerator(t = {}) {
    const e = this;
    let { reader: s } = e;
    const { config: r } = e;
    if (
      (await Ce(s),
      (s.size === V || !s.readUint8Array) &&
        ((s = new St(await new Response(s.readable).blob())), await Ce(s)),
      s.size < oe)
    )
      throw new Error(We);
    s.chunkSize = Kr(r);
    const i = await Ca(s, vr, s.size, oe, ae * 16);
    if (!i) {
      const x = await G(s, 0, 4),
        m = q(x);
      throw B(m) == Lr ? new Error(pt) : new Error(Ds);
    }
    const a = q(i);
    let c = B(a, 12),
      l = B(a, 16);
    const _ = i.offset,
      f = j(a, 20),
      b = _ + oe + f;
    let h = j(a, 4);
    const S = s.lastDiskNumber || 0;
    let C = j(a, 6),
      u = j(a, 8),
      o = 0,
      d = 0;
    if (l == pe || c == pe || u == ae || C == ae) {
      const x = await G(s, i.offset - Qe, Qe),
        m = q(x);
      if (B(m, 0) == Fr) {
        l = He(m, 8);
        let I = await G(s, l, ze, -1),
          O = q(I);
        const N = i.offset - Qe - ze;
        if (B(O, 0) != on && l != N) {
          const P = l;
          (l = N), (o = l - P), (I = await G(s, l, ze, -1)), (O = q(I));
        }
        if (B(O, 0) != on) throw new Error(ks);
        h == ae && (h = B(O, 16)),
          C == ae && (C = B(O, 20)),
          u == ae && (u = He(O, 32)),
          c == pe && (c = He(O, 40)),
          (l -= c);
      }
    }
    if ((l >= s.size && ((o = s.size - l - c - oe), (l = s.size - c - oe)), S != h))
      throw new Error(pt);
    if (l < 0) throw new Error(We);
    let y = 0,
      g = await G(s, l, c, C),
      w = q(g);
    if (c) {
      const x = i.offset - c;
      if (B(w, y) != an && l != x) {
        const m = l;
        (l = x), (o += l - m), (g = await G(s, l, c, C)), (w = q(g));
      }
    }
    const E = i.offset - l - (s.lastDiskOffset || 0);
    if (
      (c != E && E >= 0 && ((c = E), (g = await G(s, l, c, C)), (w = q(g))), l < 0 || l >= s.size)
    )
      throw new Error(We);
    const p = Z(e, t, 'filenameEncoding'),
      R = Z(e, t, 'commentEncoding');
    for (let x = 0; x < u; x++) {
      const m = new Ea(s, r, e.options);
      if (B(w, y) != an) throw new Error(Ns);
      Ws(m, w, y + 6);
      const I = !!m.bitFlag.languageEncodingFlag,
        O = y + 46,
        N = O + m.filenameLength,
        P = N + m.extraFieldLength,
        D = j(w, y + 4),
        M = D >> 8 == 0,
        L = D >> 8 == 3,
        Y = g.subarray(O, N),
        k = j(w, y + 32),
        _e = P + k,
        U = g.subarray(P, _e),
        W = I,
        Ct = I,
        Ve = B(w, y + 38),
        Ot =
          (M && (ye(w, y + 38) & un) == un) ||
          (L && ((Ve >> 16) & dn) == dn) ||
          (Y.length && Y[Y.length - 1] == hn.charCodeAt(0)),
        js = L && ((Ve >> 16) & _n) == _n,
        It = B(w, y + 42) + o;
      Object.assign(m, {
        versionMadeBy: D,
        msDosCompatible: M,
        compressedSize: 0,
        uncompressedSize: 0,
        commentLength: k,
        directory: Ot,
        offset: It,
        diskNumberStart: j(w, y + 34),
        internalFileAttributes: j(w, y + 36),
        externalFileAttributes: Ve,
        rawFilename: Y,
        filenameUTF8: W,
        commentUTF8: Ct,
        rawExtraField: g.subarray(N, P),
        executable: js,
      }),
        (m.internalFileAttribute = m.internalFileAttributes),
        (m.externalFileAttribute = m.externalFileAttributes);
      const Pt = Z(e, t, 'decodeText') || Me,
        Dt = W ? Dn : p || kn,
        kt = Ct ? Dn : R || kn;
      let ke = Pt(Y, Dt);
      ke === V && (ke = Me(Y, Dt));
      let Ze = Pt(U, kt);
      Ze === V && (Ze = Me(U, kt)),
        Object.assign(m, {
          rawComment: U,
          filename: ke,
          comment: Ze,
          directory: Ot || ke.endsWith(hn),
        }),
        (d = Math.max(It, d)),
        Hs(m, m, w, y + 6),
        (m.zipCrypto = m.encrypted && !m.extraFieldAES);
      const Ke = new Pn(m);
      (Ke.getData = (Lt, qs) => m.getData(Lt, Ke, qs)), (y = _e);
      const { onprogress: Nt } = t;
      if (Nt)
        try {
          await Nt(x + 1, u, new Pn(m));
        } catch {}
      yield Ke;
    }
    const T = Z(e, t, 'extractPrependedData'),
      A = Z(e, t, 'extractAppendedData');
    return (
      T && (e.prependedData = d > 0 ? await G(s, 0, d) : new Uint8Array()),
      (e.comment = f ? await G(s, _ + oe, f) : new Uint8Array()),
      A && (e.appendedData = b < s.size ? await G(s, b, s.size - b) : new Uint8Array()),
      !0
    );
  }
  async getEntries(t = {}) {
    const e = [];
    for await (const s of this.getEntriesGenerator(t)) e.push(s);
    return e;
  }
  async close() {}
}
class xa {
  constructor(t = {}) {
    const { readable: e, writable: s } = new TransformStream(),
      r = new Ms(e, t).getEntriesGenerator();
    (this.readable = new ReadableStream({
      async pull(i) {
        const { done: a, value: c } = await r.next();
        if (a) return i.close();
        const l = {
          ...c,
          readable: (function () {
            const { readable: _, writable: f } = new TransformStream();
            if (c.getData) return c.getData(f), _;
          })(),
        };
        delete l.getData, i.enqueue(l);
      },
    })),
      (this.writable = s);
  }
}
class Ea {
  constructor(t, e, s) {
    Object.assign(this, { reader: t, config: e, options: s });
  }
  async getData(t, e, s = {}) {
    const r = this,
      {
        reader: i,
        offset: a,
        diskNumberStart: c,
        extraFieldAES: l,
        compressionMethod: _,
        config: f,
        bitFlag: b,
        signature: h,
        rawLastModDate: S,
        uncompressedSize: C,
        compressedSize: u,
      } = r,
      o = (e.localDirectory = {}),
      d = await G(i, a, 30, c),
      y = q(d);
    let g = Z(r, s, 'password'),
      w = Z(r, s, 'rawPassword');
    const E = Z(r, s, 'passThrough');
    if (
      ((g = g && g.length && g), (w = w && w.length && w), l && l.originalCompressionMethod != kr)
    )
      throw new Error(ht);
    if (_ != Dr && _ != Pr && !E) throw new Error(ht);
    if (B(y, 0) != Nr) throw new Error(Ls);
    Ws(o, y, 4),
      (o.rawExtraField = o.extraFieldLength
        ? await G(i, a + 30 + o.filenameLength, o.extraFieldLength, c)
        : new Uint8Array()),
      Hs(r, o, y, 4, !0),
      Object.assign(e, { lastAccessDate: o.lastAccessDate, creationDate: o.creationDate });
    const p = r.encrypted && o.encrypted && !E,
      R = p && !l;
    if ((E || (e.zipCrypto = R), p)) {
      if (!R && l.strength === V) throw new Error(Us);
      if (!g && !w) throw new Error(Fs);
    }
    const T = a + 30 + o.filenameLength + o.extraFieldLength,
      A = u,
      x = i.readable;
    Object.assign(x, { diskNumberStart: c, offset: T, size: A });
    const m = Z(r, s, 'signal'),
      I = Z(r, s, 'checkPasswordOnly');
    I && (t = new WritableStream()), (t = ys(t)), await Ce(t, E ? u : C);
    const { writable: O } = t,
      { onstart: N, onprogress: P, onend: D } = s,
      M = {
        options: {
          codecType: as,
          password: g,
          rawPassword: w,
          zipCrypto: R,
          encryptionStrength: l && l.strength,
          signed: Z(r, s, 'checkSignature') && !E,
          passwordVerification: R && (b.dataDescriptor ? (S >>> 8) & 255 : (h >>> 24) & 255),
          signature: h,
          compressed: _ != 0 && !E,
          encrypted: r.encrypted && !E,
          useWebWorkers: Z(r, s, 'useWebWorkers'),
          useCompressionStream: Z(r, s, 'useCompressionStream'),
          transferStreams: Z(r, s, 'transferStreams'),
          checkPasswordOnly: I,
        },
        config: f,
        streamOptions: { signal: m, size: A, onstart: N, onprogress: P, onend: D },
      };
    let L = 0;
    try {
      ({ outputSize: L } = await Ni({ readable: x, writable: O }, M));
    } catch (Y) {
      if (!I || Y.message != gt) throw Y;
    } finally {
      const Y = Z(r, s, 'preventClose');
      (O.size += L), !Y && !O.locked && (await O.getWriter().close());
    }
    return I ? V : t.getData ? t.getData() : O;
  }
}
function Ws(n, t, e) {
  const s = (n.rawBitFlag = j(t, e + 2)),
    r = (s & cn) == cn,
    i = B(t, e + 6);
  Object.assign(n, {
    encrypted: r,
    version: j(t, e),
    bitFlag: {
      level: (s & Gr) >> 1,
      dataDescriptor: (s & ln) == ln,
      languageEncodingFlag: (s & fn) == fn,
    },
    rawLastModDate: i,
    lastModDate: Oa(i),
    filenameLength: j(t, e + 22),
    extraFieldLength: j(t, e + 24),
  });
}
function Hs(n, t, e, s, r) {
  const { rawExtraField: i } = t,
    a = (t.extraField = new Map()),
    c = q(new Uint8Array(i));
  let l = 0;
  try {
    for (; l < i.length; ) {
      const d = j(c, l),
        y = j(c, l + 2);
      a.set(d, { type: d, data: i.slice(l + 4, l + 4 + y) }), (l += 4 + y);
    }
  } catch {}
  const _ = j(e, s + 4);
  Object.assign(t, {
    signature: B(e, s + 10),
    uncompressedSize: B(e, s + 18),
    compressedSize: B(e, s + 14),
  });
  const f = a.get(Ur);
  f && (Ta(f, t), (t.extraFieldZip64 = f));
  const b = a.get(jr);
  b && (Nn(b, Es, Ts, t, n), (t.extraFieldUnicodePath = b));
  const h = a.get(qr);
  h && (Nn(h, Ss, Rs, t, n), (t.extraFieldUnicodeComment = h));
  const S = a.get(Mr);
  S ? (Sa(S, t, _), (t.extraFieldAES = S)) : (t.compressionMethod = _);
  const C = a.get(Wr);
  C && (Ra(C, t), (t.extraFieldNTFS = C));
  const u = a.get(Br);
  u && (Aa(u, t, r), (t.extraFieldExtendedTimestamp = u));
  const o = a.get(Yr);
  o && (t.extraFieldUSDZ = o);
}
function Ta(n, t) {
  t.zip64 = !0;
  const e = q(n.data),
    s = ba.filter(([r, i]) => t[r] == i);
  for (let r = 0, i = 0; r < s.length; r++) {
    const [a, c] = s[r];
    if (t[a] == c) {
      const l = ya[c];
      (t[a] = n[a] = l.getValue(e, i)), (i += l.bytes);
    } else if (n[a]) throw new Error(vs);
  }
}
function Nn(n, t, e, s, r) {
  const i = q(n.data),
    a = new Be();
  a.append(r[e]);
  const c = q(new Uint8Array(4));
  c.setUint32(0, a.get(), !0);
  const l = B(i, 1);
  Object.assign(n, {
    version: ye(i, 0),
    [t]: Me(n.data.subarray(5)),
    valid: !r.bitFlag.languageEncodingFlag && l == B(c, 0),
  }),
    n.valid && ((s[t] = n[t]), (s[t + 'UTF8'] = !0));
}
function Sa(n, t, e) {
  const s = q(n.data),
    r = ye(s, 4);
  Object.assign(n, {
    vendorVersion: ye(s, 0),
    vendorId: ye(s, 2),
    strength: r,
    originalCompressionMethod: e,
    compressionMethod: j(s, 5),
  }),
    (t.compressionMethod = n.compressionMethod);
}
function Ra(n, t) {
  const e = q(n.data);
  let s = 4,
    r;
  try {
    for (; s < n.data.length && !r; ) {
      const i = j(e, s),
        a = j(e, s + 2);
      i == Hr && (r = n.data.slice(s + 4, s + 4 + a)), (s += 4 + a);
    }
  } catch {}
  try {
    if (r && r.length == 24) {
      const i = q(r),
        a = i.getBigUint64(0, !0),
        c = i.getBigUint64(8, !0),
        l = i.getBigUint64(16, !0);
      Object.assign(n, { rawLastModDate: a, rawLastAccessDate: c, rawCreationDate: l });
      const _ = st(a),
        f = st(c),
        b = st(l),
        h = { lastModDate: _, lastAccessDate: f, creationDate: b };
      Object.assign(n, h), Object.assign(t, h);
    }
  } catch {}
}
function Aa(n, t, e) {
  const s = q(n.data),
    r = ye(s, 0),
    i = [],
    a = [];
  e
    ? ((r & 1) == 1 && (i.push(dt), a.push(_t)),
      (r & 2) == 2 && (i.push(Is), a.push(ra)),
      (r & 4) == 4 && (i.push(Ps), a.push(ia)))
    : n.data.length >= 5 && (i.push(dt), a.push(_t));
  let c = 1;
  i.forEach((l, _) => {
    if (n.data.length >= c + 4) {
      const f = B(s, c);
      t[l] = n[l] = new Date(f * 1e3);
      const b = a[_];
      n[b] = f;
    }
    c += 4;
  });
}
async function Ca(n, t, e, s, r) {
  const i = new Uint8Array(4),
    a = q(i);
  Ia(a, 0, t);
  const c = s + r;
  return (await l(s)) || (await l(Math.min(c, e)));
  async function l(_) {
    const f = e - _,
      b = await G(n, f, _);
    for (let h = b.length - s; h >= 0; h--)
      if (b[h] == i[0] && b[h + 1] == i[1] && b[h + 2] == i[2] && b[h + 3] == i[3])
        return { offset: f + h, buffer: b.slice(h, h + s).buffer };
  }
}
function Z(n, t, e) {
  return t[e] === V ? n.options[e] : t[e];
}
function Oa(n) {
  const t = (n & 4294901760) >> 16,
    e = n & 65535;
  try {
    return new Date(
      1980 + ((t & 65024) >> 9),
      ((t & 480) >> 5) - 1,
      t & 31,
      (e & 63488) >> 11,
      (e & 2016) >> 5,
      (e & 31) * 2,
      0
    );
  } catch {}
}
function st(n) {
  return new Date(Number(n / BigInt(1e4) - BigInt(116444736e5)));
}
function ye(n, t) {
  return n.getUint8(t);
}
function j(n, t) {
  return n.getUint16(t, !0);
}
function B(n, t) {
  return n.getUint32(t, !0);
}
function He(n, t) {
  return Number(n.getBigUint64(t, !0));
}
function Ia(n, t, e) {
  n.setUint32(t, e, !0);
}
function q(n) {
  return new DataView(n.buffer);
}
jn({ Inflate: Ir });
const Pa = Object.freeze(
    Object.defineProperty(
      {
        __proto__: null,
        BlobReader: St,
        BlobWriter: ds,
        Data64URIReader: Yi,
        Data64URIWriter: Gi,
        ERR_BAD_FORMAT: We,
        ERR_CENTRAL_DIRECTORY_NOT_FOUND: Ns,
        ERR_ENCRYPTED: Fs,
        ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND: ks,
        ERR_EOCDR_NOT_FOUND: Ds,
        ERR_EXTRAFIELD_ZIP64_NOT_FOUND: vs,
        ERR_HTTP_RANGE: De,
        ERR_INVALID_PASSWORD: mt,
        ERR_INVALID_SIGNATURE: wt,
        ERR_ITERATOR_COMPLETED_TOO_SOON: fs,
        ERR_LOCAL_FILE_HEADER_NOT_FOUND: Ls,
        ERR_SPLIT_ZIP_FILE: pt,
        ERR_UNSUPPORTED_COMPRESSION: ht,
        ERR_UNSUPPORTED_ENCRYPTION: Us,
        HttpRangeReader: $i,
        HttpReader: gs,
        Reader: de,
        SplitDataReader: At,
        SplitDataWriter: qe,
        SplitZipReader: ea,
        SplitZipWriter: ta,
        TextReader: Vi,
        TextWriter: Zi,
        Uint8ArrayReader: Ji,
        Uint8ArrayWriter: Qi,
        Writer: Tt,
        ZipReader: Ms,
        ZipReaderStream: xa,
        configure: jn,
        getMimeType: Xr,
        initReader: bs,
        initStream: Ce,
        initWriter: ys,
        readUint8Array: G,
        terminateWorkers: vi,
      },
      Symbol.toStringTag,
      { value: 'Module' }
    )
  ),
  Te = Pa;
class Da {
  constructor(t, e, s) {
    v(this, '_zipReader');
    v(this, '_entriesPromise');
    v(this, '_traceURL');
    (this._traceURL = t),
      Te.configure({ baseURL: self.location.href }),
      (this._zipReader = new Te.ZipReader(
        new Te.HttpReader(Na(t, e), { mode: 'cors', preventHeadRequest: !0 }),
        { useWebWorkers: !1 }
      )),
      (this._entriesPromise = this._zipReader.getEntries({ onprogress: s }).then((r) => {
        const i = new Map();
        for (const a of r) i.set(a.filename, a);
        return i;
      }));
  }
  isLive() {
    return !1;
  }
  traceURL() {
    return this._traceURL;
  }
  async entryNames() {
    return [...(await this._entriesPromise).keys()];
  }
  async hasEntry(t) {
    return (await this._entriesPromise).has(t);
  }
  async readText(t) {
    var i;
    const s = (await this._entriesPromise).get(t);
    if (!s) return;
    const r = new Te.TextWriter();
    return await ((i = s.getData) == null ? void 0 : i.call(s, r)), r.getData();
  }
  async readBlob(t) {
    const s = (await this._entriesPromise).get(t);
    if (!s) return;
    const r = new Te.BlobWriter();
    return await s.getData(r), r.getData();
  }
}
class ka {
  constructor(t, e) {
    v(this, '_entriesPromise');
    v(this, '_path');
    v(this, '_server');
    (this._path = t),
      (this._server = e),
      (this._entriesPromise = e.readFile(t).then(async (s) => {
        if (!s) throw new Error('File not found');
        const r = await s.json(),
          i = new Map();
        for (const a of r.entries) i.set(a.name, a.path);
        return i;
      }));
  }
  isLive() {
    return !0;
  }
  traceURL() {
    return this._path;
  }
  async entryNames() {
    return [...(await this._entriesPromise).keys()];
  }
  async hasEntry(t) {
    return (await this._entriesPromise).has(t);
  }
  async readText(t) {
    const e = await this._readEntry(t);
    return e == null ? void 0 : e.text();
  }
  async readBlob(t) {
    const e = await this._readEntry(t);
    return (e == null ? void 0 : e.status) === 200 ? await (e == null ? void 0 : e.blob()) : void 0;
  }
  async _readEntry(t) {
    const s = (await this._entriesPromise).get(t);
    if (s) return this._server.readFile(s);
  }
}
function Na(n, t) {
  let e = n.startsWith('http') || n.startsWith('blob') ? n : t.getFileURL(n).toString();
  return (
    e.startsWith('https://www.dropbox.com/') &&
      (e = 'https://dl.dropboxusercontent.com/' + e.substring(24)),
    e
  );
}
class La {
  constructor(t) {
    this.baseUrl = t;
  }
  getFileURL(t) {
    const e = new URL('trace/file', this.baseUrl);
    return e.searchParams.set('path', t), e;
  }
  async readFile(t) {
    const e = await fetch(this.getFileURL(t));
    if (e.status !== 404) return e;
  }
}
self.addEventListener('install', function (n) {
  self.skipWaiting();
});
self.addEventListener('activate', function (n) {
  n.waitUntil(self.clients.claim());
});
const va = new URL(self.registration.scope).pathname,
  fe = new Map(),
  Oe = new Map();
async function Fa(n, t, e, s, r) {
  var _;
  await Bs();
  const i = (e == null ? void 0 : e.id) ?? '';
  let a = Oe.get(i);
  if (!a) {
    const f = new URL((e == null ? void 0 : e.url) ?? self.registration.scope),
      b = new URL(f.searchParams.get('server') ?? '../', f);
    (a = { limit: s, traceUrls: new Set(), traceViewerServer: new La(b) }), Oe.set(i, a);
  }
  a.traceUrls.add(n);
  const c = new cr();
  try {
    const [f, b] = Vs(r, [0.5, 0.4, 0.1]),
      h = n.endsWith('json') ? new ka(n, a.traceViewerServer) : new Da(n, a.traceViewerServer, f);
    await c.load(h, b);
  } catch (f) {
    throw (
      (console.error(f),
      (_ = f == null ? void 0 : f.message) != null &&
      _.includes('Cannot find .trace file') &&
      (await c.hasEntry('index.html'))
        ? new Error(
            'Could not load trace. Did you upload a Playwright HTML report instead? Make sure to extract the archive first and then double-click the index.html file or put it on a web server.'
          )
        : f instanceof Un
          ? new Error(`Could not load trace from ${t || n}. ${f.message}`)
          : t
            ? new Error(
                `Could not load trace from ${t}. Make sure to upload a valid Playwright trace.`
              )
            : new Error(
                `Could not load trace from ${n}. Make sure a valid Playwright Trace is accessible over this url.`
              ))
    );
  }
  const l = new nr(c.storage(), (f) => c.resourceForSha1(f));
  return fe.set(n, { traceModel: c, snapshotServer: l }), c;
}
async function Ua(n) {
  var l;
  if (n.request.url.startsWith('chrome-extension://')) return fetch(n.request);
  if (n.request.headers.get('x-pw-serviceworker') === 'forward') {
    const _ = new Request(n.request);
    return _.headers.delete('x-pw-serviceworker'), fetch(_);
  }
  const t = n.request,
    e = await self.clients.get(n.clientId),
    s = self.registration.scope.startsWith('https://');
  if (t.url.startsWith(self.registration.scope)) {
    const _ = new URL(it(t.url)),
      f = _.pathname.substring(va.length - 1);
    if (f === '/ping') return await Bs(), new Response(null, { status: 200 });
    const b = _.searchParams.get('trace');
    if (f === '/contexts')
      try {
        const h = _.searchParams.has('limit') ? +_.searchParams.get('limit') : void 0,
          S = await Fa(b, _.searchParams.get('traceFileName'), e, h, (C, u) => {
            e.postMessage({ method: 'progress', params: { done: C, total: u } });
          });
        return new Response(JSON.stringify(S.contextEntries), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (h) {
        return new Response(JSON.stringify({ error: h == null ? void 0 : h.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    if (f.startsWith('/snapshotInfo/')) {
      const { snapshotServer: h } = fe.get(b) || {};
      if (!h) return new Response(null, { status: 404 });
      const S = f.substring(14);
      return h.serveSnapshotInfo(S, _.searchParams);
    }
    if (f.startsWith('/snapshot/')) {
      const { snapshotServer: h } = fe.get(b) || {};
      if (!h) return new Response(null, { status: 404 });
      const S = f.substring(10),
        C = h.serveSnapshot(S, _.searchParams, _.href);
      return s && C.headers.set('Content-Security-Policy', 'upgrade-insecure-requests'), C;
    }
    if (f.startsWith('/closest-screenshot/')) {
      const { snapshotServer: h } = fe.get(b) || {};
      if (!h) return new Response(null, { status: 404 });
      const S = f.substring(20);
      return h.serveClosestScreenshot(S, _.searchParams);
    }
    if (f.startsWith('/sha1/')) {
      const h = f.slice(6);
      for (const S of fe.values()) {
        const C = await S.traceModel.resourceForSha1(h);
        if (C) return new Response(C, { status: 200, headers: Ma(_.searchParams) });
      }
      return new Response(null, { status: 404 });
    }
    if (f.startsWith('/file/')) {
      const h = _.searchParams.get('path'),
        S = (l = Oe.get(n.clientId ?? '')) == null ? void 0 : l.traceViewerServer;
      if (!S) throw new Error('client is not initialized');
      const C = await S.readFile(h);
      return C || new Response(null, { status: 404 });
    }
    return fetch(n.request);
  }
  const r = it(e.url),
    i = new URL(r).searchParams.get('trace'),
    { snapshotServer: a } = fe.get(i) || {};
  if (!a) return new Response(null, { status: 404 });
  const c = [t.url];
  return (
    s && t.url.startsWith('https://') && c.push(t.url.replace(/^https/, 'http')),
    a.serveResource(c, t.method, r)
  );
}
function Ma(n) {
  const t = n.get('dn'),
    e = n.get('dct');
  if (!t) return;
  const s = new Headers();
  return (
    s.set(
      'Content-Disposition',
      `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(t)}`
    ),
    e && s.set('Content-Type', e),
    s
  );
}
async function Bs() {
  const n = await self.clients.matchAll(),
    t = new Set();
  for (const [e, s] of Oe) {
    if (!n.find((r) => r.id === e)) {
      Oe.delete(e);
      continue;
    }
    if (s.limit !== void 0) {
      const r = [...s.traceUrls];
      s.traceUrls = new Set(r.slice(r.length - s.limit));
    }
    s.traceUrls.forEach((r) => t.add(r));
  }
  for (const e of fe.keys()) t.has(e) || fe.delete(e);
}
self.addEventListener('fetch', function (n) {
  n.respondWith(Ua(n));
});
