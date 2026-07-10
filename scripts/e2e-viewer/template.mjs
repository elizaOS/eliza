/**
 * HTML template for the e2e run viewer. `generate.mjs` calls
 * `buildViewerHtml` and writes the result next to `data.js` / `replay.js`
 * inside `<runDir>/viewer/`; the page must work when opened straight from
 * `file://` under a strict CSP, so every style and script is inlined here and
 * the only sibling loads are the two generated `<script src>` files. All test
 * content arrives via `window.E2E_VIEWER_DATA` (no fetch/XHR — file:// forbids
 * it) and the DOM is built with `textContent`, never innerHTML, because log
 * lines, prompts and rrweb payloads are untrusted artifact bytes.
 */

/** Assemble the viewer page for one run. `playerCss` is rrweb-player's dist stylesheet, inlined so session replay needs no external asset. */
export function buildViewerHtml({ runId, generatedAt, playerCss }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>e2e viewer — ${escapeHtml(runId)}</title>
<style>
${APP_CSS}
/* rrweb-player stylesheet (inlined from node_modules at generate time) */
${playerCss}
</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div id="run-meta">
      <h1>${escapeHtml(runId)}</h1>
      <p class="muted">generated ${escapeHtml(generatedAt)}</p>
    </div>
    <input id="search" type="search" placeholder="Filter tests…" autocomplete="off">
    <div id="chips"></div>
    <select id="lane-filter"><option value="">all lanes</option></select>
    <div id="test-list"></div>
  </aside>
  <main id="detail"><div class="placeholder">No tests in this run.</div></main>
</div>
<div id="lightbox" hidden><img alt="screenshot"></div>
<script src="data.js"></script>
<script src="replay.js"></script>
<script>
${APP_JS}
</script>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const APP_CSS = `
:root {
  --bg: #101014; --panel: #17171d; --panel2: #1e1e26; --border: #2c2c36;
  --fg: #e8e8ee; --muted: #9a9aa8; --accent: #e8842c;
  --pass: #3fb96b; --fail: #e5534b; --flaky: #d9a326; --skipped: #7a7a88;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--fg);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
#app { display: flex; height: 100vh; }
#sidebar {
  width: 340px; min-width: 340px; border-right: 1px solid var(--border);
  background: var(--panel); display: flex; flex-direction: column; gap: 8px;
  padding: 12px; overflow: hidden;
}
#run-meta h1 { font-size: 15px; margin: 0; word-break: break-all; }
#run-meta p { margin: 2px 0 0; font-size: 11px; }
.muted { color: var(--muted); }
#search, #lane-filter {
  width: 100%; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--panel2); color: var(--fg);
  font: inherit;
}
#chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--border); background: var(--panel2); color: var(--muted);
  border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer;
}
.chip.active { color: var(--fg); border-color: var(--accent); }
.chip .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
#test-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.test-item {
  border: 1px solid transparent; border-radius: 6px; padding: 7px 9px;
  cursor: pointer; background: var(--panel2);
}
.test-item:hover { border-color: var(--border); }
.test-item.selected { border-color: var(--accent); }
.test-item .title { display: flex; gap: 7px; align-items: baseline; }
.test-item .title span.name { word-break: break-word; }
.test-item .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; }
.st-pass { background: var(--pass); } .st-fail { background: var(--fail); }
.st-flaky { background: var(--flaky); } .st-skipped { background: var(--skipped); }
.st-other { background: var(--muted); }
#detail { flex: 1; overflow-y: auto; padding: 20px 26px 60px; }
.placeholder { color: var(--muted); margin-top: 40px; text-align: center; }
.detail-header h2 { margin: 0 0 4px; font-size: 19px; word-break: break-word; }
.badges { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 4px; }
.badge {
  font-size: 11px; padding: 2px 9px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--panel2); color: var(--muted);
}
.badge.status { color: #fff; border: none; }
.badge.status.st-pass { background: var(--pass); } .badge.status.st-fail { background: var(--fail); }
.badge.status.st-flaky { background: var(--flaky); color: #201a00; }
.badge.status.st-skipped { background: var(--skipped); }
.filepath { font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; }
.error-box {
  border: 1px solid var(--fail); border-radius: 8px; background: rgba(229,83,75,.08);
  padding: 10px 12px; margin: 12px 0;
}
.error-box strong { color: var(--fail); }
.error-box pre { margin: 8px 0 0; }
section.block { margin-top: 26px; }
section.block > h3 {
  margin: 0 0 10px; font-size: 13px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted);
  border-bottom: 1px solid var(--border); padding-bottom: 5px;
}
video { max-width: 100%; border-radius: 8px; border: 1px solid var(--border); background: #000; }
.caption { font-size: 11px; color: var(--muted); margin-top: 3px; }
.state-strip { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 6px; }
.state-strip figure { margin: 0; flex: none; max-width: 260px; }
.state-strip img {
  max-width: 260px; max-height: 180px; border-radius: 6px;
  border: 1px solid var(--border); cursor: zoom-in; display: block; background: #000;
}
.state-strip figcaption { font-size: 11px; color: var(--muted); margin-top: 4px; text-align: center; }
.state-strip figure.plain figcaption { font-style: italic; }
.tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.tab {
  border: 1px solid var(--border); background: var(--panel2); color: var(--muted);
  border-radius: 6px 6px 0 0; padding: 4px 14px; cursor: pointer; font: inherit; font-size: 12px;
}
.tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.log-pane { display: none; }
.log-pane.active { display: block; }
.log-lines {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; max-height: 420px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
.log-line { padding: 1px 0; }
.log-line .ts { color: var(--muted); margin-right: 8px; }
.log-line.level-error, .log-line.level-fatal { color: var(--fail); }
.log-line.level-warn, .log-line.level-warning { color: var(--flaky); }
.log-line.invalid { color: var(--flaky); font-style: italic; }
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 12px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  max-height: 480px; margin: 6px 0;
}
details.card {
  border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
  margin-bottom: 10px; padding: 0 12px;
}
details.card > summary {
  cursor: pointer; padding: 9px 0; font-weight: 600; list-style-position: inside;
}
details.card > summary .tokens { font-weight: 400; color: var(--muted); font-size: 12px; margin-left: 8px; }
.traj-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); margin: 8px 0 2px; }
details.tree { margin-left: 14px; }
details.tree > summary { cursor: pointer; color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
.tree-row { margin-left: 14px; font-family: ui-monospace, monospace; font-size: 12px; word-break: break-word; }
.tree-key { color: var(--accent); }
.artifact-link { color: var(--accent); }
.note { color: var(--muted); font-size: 12px; }
.replay-shell { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: var(--panel2); overflow-x: auto; }
#lightbox {
  position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 50;
  display: flex; align-items: center; justify-content: center; cursor: zoom-out;
}
/* display:flex above would defeat the hidden attribute's UA display:none */
#lightbox[hidden] { display: none; }
#lightbox img { max-width: 94vw; max-height: 94vh; border-radius: 6px; }
.rr-player { background: #fff; border-radius: 6px; }
`;

// The viewer app. Untrusted artifact content is rendered via textContent
// only; every catch below is either a J3 explicit-invalid render for
// malformed artifact data or J6 player teardown.
const APP_JS = String.raw`
(function () {
  "use strict";
  var DATA = window.E2E_VIEWER_DATA;
  if (!DATA || !Array.isArray(DATA.tests)) {
    document.getElementById("detail").textContent = "data.js failed to load or is malformed.";
    return;
  }
  var state = { search: "", statuses: {}, lane: "", selectedId: null };
  var currentPlayer = null;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "text") node.textContent = attrs[key];
        else if (key === "className") node.className = attrs[key];
        else if (key === "onclick") node.addEventListener("click", attrs[key]);
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function statusClass(status) {
    return ["pass", "fail", "flaky", "skipped"].indexOf(status) >= 0 ? "st-" + status : "st-other";
  }

  function fmtMs(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    if (ms < 1000) return Math.round(ms) + "ms";
    return (ms / 1000).toFixed(1) + "s";
  }

  function fmtTs(value) {
    if (typeof value === "number" && isFinite(value)) {
      // Epoch seconds vs milliseconds: anything below 1e12 is seconds.
      var ms = value < 1e12 ? value * 1000 : value;
      var d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString().slice(11, 23);
    }
    if (typeof value === "string") {
      var idx = value.indexOf("T");
      return idx >= 0 ? value.slice(idx + 1).replace("Z", "") : value;
    }
    return "";
  }

  function artifactsOf(test, kind) {
    return (test.artifacts || []).filter(function (a) { return a.kind === kind; });
  }

  // ---- sidebar -------------------------------------------------------------

  function visibleTests() {
    var query = state.search.toLowerCase();
    var activeStatuses = Object.keys(state.statuses).filter(function (s) { return state.statuses[s]; });
    return DATA.tests.filter(function (t) {
      if (activeStatuses.length && activeStatuses.indexOf(t.status) < 0) return false;
      if (state.lane && t.lane !== state.lane) return false;
      if (query) {
        var hay = ((t.title || "") + " " + (t.file || "") + " " + (t.id || "")).toLowerCase();
        if (hay.indexOf(query) < 0) return false;
      }
      return true;
    });
  }

  function renderChips() {
    var box = document.getElementById("chips");
    box.textContent = "";
    var counts = (DATA.index && DATA.index.statusCounts) || {};
    var order = ["pass", "fail", "flaky", "skipped"].concat(
      Object.keys(counts).filter(function (s) { return ["pass", "fail", "flaky", "skipped"].indexOf(s) < 0; })
    );
    order.forEach(function (status) {
      if (!(status in counts)) return;
      var chip = el("button", {
        className: "chip" + (state.statuses[status] ? " active" : ""),
        onclick: function () {
          state.statuses[status] = !state.statuses[status];
          renderChips();
          renderList();
        },
      }, [
        el("span", { className: "dot " + statusClass(status) }),
        document.createTextNode(status + " " + counts[status]),
      ]);
      box.appendChild(chip);
    });
  }

  function renderLaneFilter() {
    var select = document.getElementById("lane-filter");
    var lanes = Object.keys((DATA.index && DATA.index.laneCounts) || {}).sort();
    lanes.forEach(function (lane) {
      select.appendChild(el("option", { value: lane, text: lane }));
    });
    select.addEventListener("change", function () {
      state.lane = select.value;
      renderList();
    });
  }

  function renderList() {
    var list = document.getElementById("test-list");
    list.textContent = "";
    var tests = visibleTests();
    if (!tests.length) {
      list.appendChild(el("div", { className: "placeholder", text: "No tests match." }));
      return;
    }
    tests.forEach(function (t) {
      var item = el("div", {
        className: "test-item" + (t.id === state.selectedId ? " selected" : ""),
        onclick: function () { selectTest(t.id); },
      }, [
        el("div", { className: "title" }, [
          el("span", { className: "dot " + statusClass(t.status) }),
          el("span", { className: "name", text: t.title || t.id }),
        ]),
        el("div", { className: "meta", text: [t.lane, t.project, fmtMs(t.durationMs)].filter(Boolean).join(" · ") }),
      ]);
      list.appendChild(item);
    });
  }

  // ---- detail --------------------------------------------------------------

  function selectTest(id) {
    if (currentPlayer) {
      try {
        if (typeof currentPlayer.$destroy === "function") currentPlayer.$destroy();
      } catch (err) { // error-policy:J6 best-effort teardown of the previous rrweb player
        console.warn("[e2e-viewer] player teardown failed", err);
      }
      currentPlayer = null;
    }
    state.selectedId = id;
    renderList();
    var test = DATA.tests.filter(function (t) { return t.id === id; })[0];
    var detail = document.getElementById("detail");
    detail.textContent = "";
    if (!test) {
      detail.appendChild(el("div", { className: "placeholder", text: "Test not found." }));
      return;
    }
    detail.appendChild(buildHeader(test));
    var video = buildVideos(test); if (video) detail.appendChild(video);
    var states = buildStateStrip(test); if (states) detail.appendChild(states);
    var logs = buildLogs(test); if (logs) detail.appendChild(logs);
    var traj = buildTrajectories(test); if (traj) detail.appendChild(traj);
    var replay = buildReplay(test); if (replay) detail.appendChild(replay);
    var other = buildOtherArtifacts(test); if (other) detail.appendChild(other);
    detail.scrollTop = 0;
  }

  function collectErrors(test) {
    var out = [];
    function push(err) {
      if (err == null) return;
      if (typeof err === "string") out.push({ message: err });
      else if (typeof err === "object") out.push({ message: err.message || JSON.stringify(err), stack: err.stack });
    }
    push(test.error);
    if (Array.isArray(test.errors)) test.errors.forEach(push);
    return out;
  }

  function buildHeader(test) {
    var wrap = el("div", { className: "detail-header" });
    wrap.appendChild(el("h2", { text: test.title || test.id }));
    var badges = el("div", { className: "badges" });
    badges.appendChild(el("span", { className: "badge status " + statusClass(test.status), text: test.status }));
    if (test.lane) badges.appendChild(el("span", { className: "badge", text: test.lane }));
    if (test.project) badges.appendChild(el("span", { className: "badge", text: test.project }));
    if (test.durationMs != null) badges.appendChild(el("span", { className: "badge", text: fmtMs(test.durationMs) }));
    if (test.startedAt) badges.appendChild(el("span", { className: "badge", text: "started " + test.startedAt }));
    wrap.appendChild(badges);
    if (test.file) wrap.appendChild(el("div", { className: "filepath", text: test.file }));
    collectErrors(test).forEach(function (err) {
      var box = el("div", { className: "error-box" });
      box.appendChild(el("strong", { text: err.message }));
      if (err.stack) box.appendChild(el("pre", { text: err.stack }));
      wrap.appendChild(box);
    });
    var links = test.links;
    if (links && typeof links === "object") {
      var row = el("div", { className: "badges" });
      Object.keys(links).forEach(function (name) {
        row.appendChild(el("a", { className: "artifact-link", href: String(links[name]), target: "_blank", rel: "noreferrer", text: name }));
      });
      if (row.childNodes.length) wrap.appendChild(row);
    }
    return wrap;
  }

  function section(title) {
    var sec = el("section", { className: "block" });
    sec.appendChild(el("h3", { text: title }));
    return sec;
  }

  function buildVideos(test) {
    var videos = artifactsOf(test, "video");
    if (!videos.length) return null;
    var sec = section("Video");
    videos.forEach(function (a) {
      var video = el("video", { controls: "", preload: "metadata" });
      video.src = a.href;
      sec.appendChild(video);
      sec.appendChild(el("div", { className: "caption", text: a.label || a.path }));
    });
    return sec;
  }

  function buildStateStrip(test) {
    var states = artifactsOf(test, "state-screenshot");
    var shots = artifactsOf(test, "screenshot");
    if (!states.length && !shots.length) return null;
    var sec = section("States & screenshots");
    var strip = el("div", { className: "state-strip" });
    states.concat(shots).forEach(function (a) {
      var isState = a.kind === "state-screenshot";
      // No loading="lazy": Chromium never triggers lazy loads for file://
      // images inside the overflow-x strip, leaving blank frames.
      var img = el("img", { src: a.href, alt: a.stateName || a.label || a.path });
      img.addEventListener("click", function () { openLightbox(a.href); });
      var fig = el("figure", { className: isState ? "" : "plain" }, [
        img,
        el("figcaption", { text: (isState ? a.stateName : null) || a.label || a.path }),
      ]);
      strip.appendChild(fig);
    });
    sec.appendChild(strip);
    return sec;
  }

  function openLightbox(href) {
    var box = document.getElementById("lightbox");
    box.querySelector("img").src = href;
    box.hidden = false;
  }

  function logLevel(value) {
    var raw = value && (value.level || value.type);
    return typeof raw === "string" ? raw.toLowerCase() : "";
  }

  function lineSummary(value) {
    if (value == null || typeof value !== "object") return String(value);
    var parts = [];
    var level = logLevel(value);
    if (level) parts.push("[" + level + "]");
    if (value.method || value.url) {
      parts.push([value.method, value.url].filter(Boolean).join(" ") + (value.status != null ? " -> " + value.status : ""));
    }
    var msg = value.text != null ? value.text : value.message != null ? value.message : value.msg;
    if (msg != null) parts.push(typeof msg === "string" ? msg : JSON.stringify(msg));
    if (parts.length <= (level ? 1 : 0)) return JSON.stringify(value);
    return parts.join(" ");
  }

  function buildLogArtifact(artifact) {
    var wrap = el("div");
    if (artifact.inline && artifact.inline.type === "jsonl") {
      var box = el("div", { className: "log-lines" });
      artifact.inline.lines.forEach(function (line) {
        if (!line.ok) {
          box.appendChild(el("div", { className: "log-line invalid", text: "(unparsed) " + line.raw }));
          return;
        }
        var v = line.value;
        var ts = fmtTs(v && (v.ts != null ? v.ts : v.timestamp != null ? v.timestamp : v.time != null ? v.time : v.t));
        var row = el("div", { className: "log-line level-" + (logLevel(v) || "info") });
        if (ts) row.appendChild(el("span", { className: "ts", text: ts }));
        row.appendChild(document.createTextNode(lineSummary(v)));
        box.appendChild(row);
      });
      wrap.appendChild(box);
    } else if (artifact.inline && artifact.inline.type === "text") {
      wrap.appendChild(el("pre", { text: artifact.inline.text }));
    } else if (artifact.inline && artifact.inline.type === "json") {
      wrap.appendChild(el("pre", { text: JSON.stringify(artifact.inline.value, null, 2) }));
    } else if (artifact.inline && artifact.inline.type === "invalid-json") {
      wrap.appendChild(el("div", { className: "note", text: "File is not valid JSON — raw content below." }));
      wrap.appendChild(el("pre", { text: artifact.inline.raw }));
    } else {
      var reason = artifact.inlineSkipped === "too-large"
        ? "too large to inline (" + Math.round((artifact.sizeBytes || 0) / 1024) + " KB)"
        : artifact.inlineSkipped === "missing" ? "file missing on disk" : "not inlined";
      var note = el("div", { className: "note" });
      note.appendChild(document.createTextNode(reason + " — "));
      note.appendChild(el("a", { className: "artifact-link", href: artifact.href, text: artifact.path }));
      wrap.appendChild(note);
    }
    return wrap;
  }

  function buildLogs(test) {
    var kinds = [
      ["console-log", "Console"],
      ["network-log", "Network"],
      ["server-log", "Server"],
    ].map(function (pair) {
      return { kind: pair[0], name: pair[1], artifacts: artifactsOf(test, pair[0]) };
    }).filter(function (entry) { return entry.artifacts.length; });
    if (!kinds.length) return null;
    var sec = section("Logs");
    var tabs = el("div", { className: "tabs" });
    var panes = [];
    kinds.forEach(function (entry, index) {
      var pane = el("div", { className: "log-pane" + (index === 0 ? " active" : "") });
      entry.artifacts.forEach(function (a) {
        if (entry.artifacts.length > 1) pane.appendChild(el("div", { className: "caption", text: a.label || a.path }));
        pane.appendChild(buildLogArtifact(a));
      });
      panes.push(pane);
      var tab = el("button", {
        className: "tab" + (index === 0 ? " active" : ""),
        text: entry.name,
        onclick: function () {
          tabs.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
          panes.forEach(function (p) { p.classList.remove("active"); });
          tab.classList.add("active");
          pane.classList.add("active");
        },
      });
      tabs.appendChild(tab);
    });
    sec.appendChild(tabs);
    panes.forEach(function (pane) { sec.appendChild(pane); });
    return sec;
  }

  // ---- trajectory ----------------------------------------------------------

  function jsonTree(value, label, open) {
    if (value === null || typeof value !== "object") {
      return el("div", { className: "tree-row" }, [
        label ? el("span", { className: "tree-key", text: label + ": " }) : null,
        document.createTextNode(JSON.stringify(value)),
      ]);
    }
    var isArray = Array.isArray(value);
    var keys = isArray ? value.map(function (_, i) { return i; }) : Object.keys(value);
    var summaryText = (label ? label + " " : "") + (isArray ? "Array(" + keys.length + ")" : "{" + keys.length + " keys}");
    var details = el("details", { className: "tree" });
    if (open) details.setAttribute("open", "");
    details.appendChild(el("summary", { text: summaryText }));
    keys.forEach(function (key) {
      details.appendChild(jsonTree(value[key], String(key), false));
    });
    return details;
  }

  function pickText(stage, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = stage[keys[i]];
      if (typeof v === "string" && v.length) return v;
      if (v != null && typeof v === "object") return JSON.stringify(v, null, 2);
    }
    return null;
  }

  function trajectoryStages(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      var keys = ["stages", "calls", "llmCalls", "steps", "trajectory", "records", "entries"];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(value[keys[i]])) return value[keys[i]];
      }
    }
    return null;
  }

  function tokensSummary(stage) {
    var usage = stage.usage || stage.tokens;
    if (usage == null) return "";
    if (typeof usage === "number") return usage + " tok";
    if (typeof usage === "object") {
      return Object.keys(usage).map(function (k) { return k + "=" + usage[k]; }).join(" ");
    }
    return String(usage);
  }

  function buildTrajectories(test) {
    var artifacts = artifactsOf(test, "trajectory");
    if (!artifacts.length) return null;
    var sec = section("Trajectory");
    artifacts.forEach(function (a) {
      if (artifacts.length > 1) sec.appendChild(el("div", { className: "caption", text: a.label || a.path }));
      if (!a.inline || a.inline.type === "invalid-json") {
        sec.appendChild(buildLogArtifact(a));
        return;
      }
      var value = a.inline.type === "json" ? a.inline.value
        : a.inline.type === "jsonl" ? a.inline.lines.filter(function (l) { return l.ok; }).map(function (l) { return l.value; })
        : null;
      if (value == null) {
        sec.appendChild(buildLogArtifact(a));
        return;
      }
      var stages = trajectoryStages(value);
      if (!stages || !stages.length || stages.some(function (s) { return s == null || typeof s !== "object"; })) {
        // Unknown recorder shape: fall back to a browsable raw JSON tree.
        sec.appendChild(jsonTree(value, a.label || a.path, true));
        return;
      }
      stages.forEach(function (stage, index) {
        var name = [stage.name, stage.stage, stage.step, stage.model, stage.modelType].filter(function (v) { return typeof v === "string"; }).join(" · ");
        var card = el("details", { className: "card" });
        if (index === 0) card.setAttribute("open", "");
        var summary = el("summary", { text: "Call " + (index + 1) + (name ? " — " + name : "") });
        var tokens = tokensSummary(stage);
        if (tokens) summary.appendChild(el("span", { className: "tokens", text: tokens }));
        card.appendChild(summary);
        var prompt = pickText(stage, ["prompt", "input", "request", "messages"]);
        var response = pickText(stage, ["response", "output", "completion", "result", "text"]);
        if (prompt != null) {
          card.appendChild(el("div", { className: "traj-label", text: "prompt" }));
          card.appendChild(el("pre", { text: prompt }));
        }
        if (response != null) {
          card.appendChild(el("div", { className: "traj-label", text: "response" }));
          card.appendChild(el("pre", { text: response }));
        }
        if (prompt == null && response == null) card.appendChild(jsonTree(stage, null, true));
        sec.appendChild(card);
      });
    });
    return sec;
  }

  // ---- session replay --------------------------------------------------------

  function looksLikeRrwebEvent(value) {
    return value != null && typeof value === "object" &&
      typeof value.type === "number" && typeof value.timestamp === "number";
  }

  function extractRrwebEvents(value, depth) {
    if (value == null || depth > 6) return [];
    if (Array.isArray(value)) {
      return value.reduce(function (acc, item) { return acc.concat(extractRrwebEvents(item, depth + 1)); }, []);
    }
    if (typeof value === "string") {
      try {
        return extractRrwebEvents(JSON.parse(value), depth + 1);
      } catch (_err) { // error-policy:J3 non-JSON snapshot payload string is explicitly not an event
        return [];
      }
    }
    if (typeof value !== "object") return [];
    if (looksLikeRrwebEvent(value)) return [value];
    var props = value.properties && typeof value.properties === "object" ? value.properties : value;
    var payloadKeys = ["$snapshot_data", "$snapshot_bytes", "snapshot_data", "data"];
    for (var i = 0; i < payloadKeys.length; i++) {
      var payload = props[payloadKeys[i]];
      if (payload != null) {
        var events = extractRrwebEvents(payload, depth + 1);
        if (events.length) return events;
      }
    }
    return [];
  }

  function buildReplay(test) {
    var artifacts = artifactsOf(test, "posthog-snapshots");
    if (!artifacts.length) return null;
    var sec = section("Session replay");
    var events = [];
    artifacts.forEach(function (a) {
      if (a.inline && a.inline.type === "jsonl") {
        a.inline.lines.forEach(function (line) {
          if (line.ok) events = events.concat(extractRrwebEvents(line.value, 0));
        });
      } else if (a.inline && a.inline.type === "json") {
        events = events.concat(extractRrwebEvents(a.inline.value, 0));
      } else {
        sec.appendChild(buildLogArtifact(a));
      }
    });
    events.sort(function (a, b) { return a.timestamp - b.timestamp; });
    if (events.length < 2) {
      sec.appendChild(el("div", { className: "note", text: "Replay unavailable: " + events.length + " rrweb event(s) recovered from snapshots." }));
      return sec;
    }
    if (typeof window.rrwebPlayer !== "function") {
      sec.appendChild(el("div", { className: "note", text: "replay.js did not load — rrweb player unavailable." }));
      return sec;
    }
    var shell = el("div", { className: "replay-shell" });
    sec.appendChild(shell);
    var width = Math.max(480, Math.min(1024, document.getElementById("detail").clientWidth - 80));
    try {
      currentPlayer = new window.rrwebPlayer({
        target: shell,
        props: { events: events, autoPlay: false, width: width, height: Math.round(width * 0.6), showController: true },
      });
    } catch (err) { // error-policy:J4 corrupt snapshot streams render a designed error note instead of killing the whole detail view
      console.error("[e2e-viewer] rrweb player failed", err);
      shell.appendChild(el("div", { className: "note", text: "Replay failed to initialise: " + (err && err.message ? err.message : String(err)) }));
    }
    sec.appendChild(el("div", { className: "caption", text: events.length + " rrweb events" }));
    return sec;
  }

  function buildOtherArtifacts(test) {
    var handled = ["video", "screenshot", "state-screenshot", "console-log", "network-log", "server-log", "trajectory", "posthog-snapshots"];
    var rest = (test.artifacts || []).filter(function (a) { return handled.indexOf(a.kind) < 0; });
    if (!rest.length) return null;
    var sec = section("Other artifacts");
    rest.forEach(function (a) {
      var row = el("div", { className: "log-line" });
      row.appendChild(el("span", { className: "badge", text: a.kind }));
      row.appendChild(document.createTextNode(" "));
      row.appendChild(el("a", { className: "artifact-link", href: a.href, text: a.label || a.path }));
      sec.appendChild(row);
      if (a.inline && (a.inline.type === "json" || a.inline.type === "jsonl" || a.inline.type === "text")) {
        sec.appendChild(buildLogArtifact(a));
      }
    });
    return sec;
  }

  // ---- boot ----------------------------------------------------------------

  document.getElementById("search").addEventListener("input", function (event) {
    state.search = event.target.value;
    renderList();
  });
  document.getElementById("lightbox").addEventListener("click", function () {
    document.getElementById("lightbox").hidden = true;
  });
  renderChips();
  renderLaneFilter();
  renderList();
  if (DATA.tests.length) selectTest(DATA.tests[0].id);
})();
`;
