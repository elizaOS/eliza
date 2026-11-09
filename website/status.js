(function (root) {
  var NAMES = ["VALHALLA CORE", "MECHA BRAIN", "ASK VALHALLA", "ODIN FEED", "FORGE LAB", "HEIMDALL GATE", "SENTINEL WATCH"];

  function clear(host) {
    while (host.firstChild) host.removeChild(host.firstChild);
  }

  function age(checkedAt) {
    var seconds = Math.max(0, Math.round((Date.now() - checkedAt) / 1000));
    if (seconds < 60) return "checked just now";
    return "checked " + Math.floor(seconds / 60) + "m ago";
  }

  function addText(parent, tag, className, text) {
    var item = document.createElement(tag);
    if (className) item.className = className;
    item.textContent = text;
    parent.appendChild(item);
    return item;
  }

  function unavailable(host, message) {
    clear(host);
    host.className = "system-status system-status-unavailable";
    var line = document.createElement("div");
    line.className = "system-status-line";
    addText(line, "span", "system-status-dot", "");
    addText(line, "strong", "", "SYSTEM STATUS · UNAVAILABLE");
    addText(line, "span", "system-status-note", message || "Status feed is not configured. System health is not being reported.");
    host.appendChild(line);
  }

  function render(host, data) {
    var checkedAt = Number(data && data.checkedAt);
    var lines = data && data.lines;
    if (!Number.isFinite(checkedAt) || checkedAt <= 0 || !Array.isArray(lines) ||
        lines.length !== NAMES.length ||
        lines.some(function (line, index) {
          return !line || line.name !== NAMES[index] ||
            ["LIVE", "DEGRADED", "OFFLINE"].indexOf(line.state) < 0;
        })) {
      unavailable(host, "The status service returned incomplete data. No systems are being reported as live.");
      return;
    }

    if (Date.now() - checkedAt > 15 * 60 * 1000) {
      unavailable(host, "The last health check is stale. System health is not being reported as live.");
      return;
    }

    var state = lines.some(function (line) { return line.state === "OFFLINE"; }) ? "OFFLINE" :
      lines.some(function (line) { return line.state === "DEGRADED"; }) ? "DEGRADED" : "LIVE";
    clear(host);
    host.className = "system-status system-status-" + state.toLowerCase();

    var button = document.createElement("button");
    button.type = "button";
    button.className = "system-status-line";
    button.setAttribute("aria-expanded", "false");
    addText(button, "span", "system-status-dot", "");
    addText(button, "strong", "", "SYSTEMS · " + state);
    addText(button, "span", "system-status-note", age(checkedAt));

    var panel = document.createElement("div");
    panel.className = "system-status-panel";
    panel.hidden = true;
    lines.forEach(function (line) {
      var row = document.createElement("div");
      row.className = "system-status-row system-status-" + line.state.toLowerCase();
      addText(row, "span", "system-status-dot", "");
      addText(row, "span", "", line.name);
      addText(row, "strong", "", line.state);
      panel.appendChild(row);
    });
    if (data.hive && typeof data.hive.nodes === "number") {
      addText(panel, "p", "system-status-hive", data.hive.enabled === true
        ? "THE HIVE · " + data.hive.nodes + " nodes live"
        : "THE HIVE · off");
    }
    addText(panel, "p", "system-status-updated", age(checkedAt) + " · status checks are not a guarantee of service availability");
    button.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    });
    host.appendChild(button);
    host.appendChild(panel);
  }

  function mount(target) {
    if (!target || target.dataset.statusBound === "1") return;
    target.dataset.statusBound = "1";
    var host = document.createElement("div");
    host.className = "system-status";
    target.appendChild(host);

    async function pull() {
      var url = String((root.VALHALLA_SITE || {}).STATUS_URL || "");
      if (!url) {
        unavailable(host);
        return;
      }
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timeout = controller ? window.setTimeout(function () { controller.abort(); }, 8000) : 0;
      try {
        var response = await fetch(url, {
          cache: "no-store",
          signal: controller ? controller.signal : undefined
        });
        if (!response.ok) throw new Error("status " + response.status);
        render(host, await response.json());
      } catch (err) {
        unavailable(host, "Could not reach the status service. System health is not being reported as live.");
        console.debug("valhalla", "V-STATUS", String(err && err.message || err));
      } finally {
        if (timeout) window.clearTimeout(timeout);
      }
    }

    pull();
    window.setInterval(pull, 60000);
  }

  function boot() {
    document.querySelectorAll("[data-status-slot]").forEach(mount);
    var board = document.getElementById("statusBoard");
    if (board) mount(board);
  }

  root.ValhallaStatus = { mount: mount };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
