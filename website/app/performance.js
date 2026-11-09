(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ValhallaPerformance = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  var PREFIX = "valhalla-performance-v1:";
  var MAX_RECORDS = 100;
  var MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  var COLORS = ["#69ffc0", "#ffc66d", "#8bc9ff", "#ff8e9b"];

  function localStorageOf() {
    try { return root.localStorage || null; } catch (err) { return null; }
  }

  function identity() {
    var storage = localStorageOf();
    if (!storage) return "device";
    try {
      var session = JSON.parse(storage.getItem("valhalla-session") || "null");
      if (!session || !session.at || Date.now() - Number(session.at) > 12 * 60 * 60 * 1000) return "device";
      var id = String(session.pubkey || session.email || (session.kind === "paper" ? "paper" : "")).trim().toLowerCase();
      return id ? String(session.kind || "account") + ":" + id : "device";
    } catch (err) {
      return "device";
    }
  }

  function scopeHash(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function label(value, fallback, max) {
    var safe = String(value || "").replace(/[^a-zA-Z0-9._:/-]/g, "").slice(0, max);
    return safe || fallback;
  }

  function valid(record, now) {
    return record && Number.isFinite(Number(record.at)) &&
      Number(now) - Number(record.at) <= MAX_AGE &&
      Number.isFinite(Number(record.durationMs)) && Number(record.durationMs) >= 0 &&
      (record.status === "ok" || record.status === "error");
  }

  function createStore(storage, getIdentity) {
    function key() {
      var who = typeof getIdentity === "function" ? getIdentity() : "device";
      return PREFIX + scopeHash(String(who || "device"));
    }

    function read() {
      if (!storage) return [];
      try {
        var parsed = JSON.parse(storage.getItem(key()) || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(function (row) { return valid(row, Date.now()); }).slice(-MAX_RECORDS);
      } catch (err) {
        return [];
      }
    }

    function record(input) {
      if (!storage || !input || !Number.isFinite(Number(input.durationMs)) || Number(input.durationMs) < 0) return false;
      var row = {
        at: Date.now(),
        provider: label(input.provider, "unknown", 32),
        model: label(input.model, "unreported", 80),
        durationMs: Math.round(Math.min(Number(input.durationMs), 600000)),
        firstTextMs: Number.isFinite(Number(input.firstTextMs)) && input.firstTextMs !== null
          ? Math.round(Math.max(0, Math.min(Number(input.firstTextMs), 600000))) : null,
        outputChars: Math.round(Math.max(0, Math.min(Number(input.outputChars) || 0, 100000))),
        status: input.status === "ok" ? "ok" : "error"
      };
      try {
        var rows = read();
        rows.push(row);
        storage.setItem(key(), JSON.stringify(rows.slice(-MAX_RECORDS)));
        return true;
      } catch (err) {
        return false;
      }
    }

    function clear() {
      if (!storage) return false;
      try {
        storage.removeItem(key());
        return true;
      } catch (err) {
        return false;
      }
    }

    function exportData() {
      return { version: 1, scope: "this browser", exportedAt: new Date().toISOString(), records: read() };
    }

    return { key: key, read: read, record: record, clear: clear, exportData: exportData };
  }

  function percentile(values, ratio) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  }

  function summaries(records) {
    var groups = Object.create(null);
    records.forEach(function (item) {
      var name = item.provider + " / " + item.model;
      if (!groups[name]) groups[name] = { name: name, ok: 0, errors: 0, times: [] };
      if (item.status === "ok") {
        groups[name].ok += 1;
        groups[name].times.push(Number(item.durationMs));
      } else {
        groups[name].errors += 1;
      }
    });
    return Object.keys(groups).sort().map(function (name) {
      var group = groups[name];
      return {
        name: name,
        ok: group.ok,
        errors: group.errors,
        medianMs: percentile(group.times, 0.5),
        p95Ms: percentile(group.times, 0.95)
      };
    });
  }

  function textNode(doc, parent, name, attrs, text) {
    var item = doc.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function (key) { item.setAttribute(key, attrs[key]); });
    item.textContent = text;
    parent.appendChild(item);
    return item;
  }

  function renderChart(svg, records) {
    var doc = svg.ownerDocument;
    svg.replaceChildren();
    var rows = records.filter(function (row) { return row.status === "ok"; }).slice(-20);
    if (!rows.length) {
      textNode(doc, svg, "text", { x: 18, y: 82, class: "performance-empty" },
        "No successful model responses measured yet");
      return;
    }
    var names = [];
    rows.forEach(function (row) {
      var name = row.provider + " / " + row.model;
      if (names.indexOf(name) < 0) names.push(name);
    });
    var max = Math.max(1000, ...rows.map(function (row) { return Number(row.durationMs); }));
    var plot = { left: 52, right: 672, top: 18, bottom: 156 };
    [0, 0.5, 1].forEach(function (ratio) {
      var y = plot.bottom - (plot.bottom - plot.top) * ratio;
      textNode(doc, svg, "line", { x1: plot.left, y1: y, x2: plot.right, y2: y, class: "performance-grid" }, "");
      textNode(doc, svg, "text", { x: 4, y: y + 4, class: "performance-axis" },
        Math.round(max * ratio) + " ms");
    });
    textNode(doc, svg, "line", {
      x1: plot.left, y1: plot.top, x2: plot.left, y2: plot.bottom, class: "performance-axis-line"
    }, "");
    textNode(doc, svg, "line", {
      x1: plot.left, y1: plot.bottom, x2: plot.right, y2: plot.bottom, class: "performance-axis-line"
    }, "");
    rows.forEach(function (row, index) {
      var name = row.provider + " / " + row.model;
      var x = plot.left + 8 + index * ((plot.right - plot.left - 16) / Math.max(1, rows.length));
      var height = Math.max(2, (Number(row.durationMs) / max) * (plot.bottom - plot.top));
      var rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x);
      rect.setAttribute("y", plot.bottom - height);
      rect.setAttribute("width", Math.max(5, Math.min(20, 560 / rows.length)));
      rect.setAttribute("height", height);
      rect.setAttribute("class", "performance-bar");
      rect.setAttribute("fill", COLORS[names.indexOf(name) % COLORS.length]);
      var title = doc.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = name + " · " + Math.round(row.durationMs) + " ms";
      rect.appendChild(title);
      svg.appendChild(rect);
    });
    textNode(doc, svg, "text", { x: plot.left, y: 184, class: "performance-axis" }, "Older");
    textNode(doc, svg, "text", { x: plot.right, y: 184, "text-anchor": "end", class: "performance-axis" }, "Most recent");
  }

  var storage = localStorageOf();
  var store = createStore(storage, identity);

  function render() {
    var doc = root.document;
    if (!doc) return;
    var records = store.read();
    var good = records.filter(function (row) { return row.status === "ok"; });
    var failures = records.length - good.length;
    var summary = doc.getElementById("performanceSummary");
    if (summary) {
      if (good.length) {
        var times = good.map(function (row) { return Number(row.durationMs); });
        summary.textContent = good.length + " successful model response" + (good.length === 1 ? "" : "s")
          + " · median " + (percentile(times, 0.5) / 1000).toFixed(2) + " s"
          + " · p95 " + (percentile(times, 0.95) / 1000).toFixed(2) + " s"
          + " · " + failures + " failed request" + (failures === 1 ? "" : "s");
      } else {
        summary.textContent = failures
          ? "No successful model responses yet · " + failures + " failed request" + (failures === 1 ? "" : "s")
          : "No model responses measured on this browser profile yet.";
      }
    }
    var chart = doc.getElementById("performanceChart");
    if (chart) renderChart(chart, records);
    var models = doc.getElementById("performanceModels");
    if (models) {
      models.replaceChildren();
      summaries(records).forEach(function (item) {
        var row = doc.createElement("p");
        row.textContent = item.name + " · " + item.ok + " ok · " + item.errors + " failed"
          + (item.ok ? " · median " + (item.medianMs / 1000).toFixed(2) + " s · p95 " + (item.p95Ms / 1000).toFixed(2) + " s" : "");
        models.appendChild(row);
      });
    }
    var hiveBadge = doc.getElementById("performanceHive");
    if (hiveBadge) {
      var hive = {};
      try { hive = JSON.parse((storage && storage.getItem("valhalla-hive")) || "{}"); } catch (err) { hive = {}; }
      var connected = hive.optIn === true && hive.nodeId && hive.active === true;
      hiveBadge.textContent = connected ? "THE HIVE · CONNECTED" : "THE HIVE · OFF";
      hiveBadge.dataset.state = connected ? "on" : "off";
    }
  }

  function exportFile() {
    if (!root.document || !root.Blob || !root.URL || !root.URL.createObjectURL) return false;
    var link = root.document.createElement("a");
    var url = root.URL.createObjectURL(new root.Blob([JSON.stringify(store.exportData(), null, 2)], {
      type: "application/json"
    }));
    link.href = url;
    link.download = "valhalla-performance.json";
    link.click();
    root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000);
    return true;
  }

  function boot() {
    if (!root.document) return;
    render();
    var exportButton = root.document.getElementById("performanceExport");
    var clearButton = root.document.getElementById("performanceClear");
    if (exportButton) exportButton.addEventListener("click", function () {
      var note = root.document.getElementById("performanceNote");
      if (note) note.textContent = exportFile()
        ? "Downloaded local timing data. It contains no prompts, replies, or account identifiers."
        : "This browser cannot create a performance export.";
    });
    if (clearButton) clearButton.addEventListener("click", function () {
      var note = root.document.getElementById("performanceNote");
      var cleared = store.clear();
      render();
      if (note) note.textContent = cleared ? "Measurements for this browser profile were cleared." : "Local measurements could not be cleared.";
    });
    root.addEventListener("valhalla-hive-updated", render);
    root.addEventListener("storage", function (event) {
      if (!event.key || event.key.indexOf(PREFIX) === 0 || event.key === "valhalla-hive") render();
    });
  }

  var api = {
    createStore: createStore,
    summaries: summaries,
    record: function (input) {
      var saved = store.record(input);
      render();
      return saved;
    },
    read: store.read,
    clear: store.clear,
    exportData: store.exportData,
    render: render,
    exportFile: exportFile
  };
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
  return api;
});
