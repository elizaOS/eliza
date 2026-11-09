(function () {
  var owner = false;
  var models = [];
  var cfg = window.VALHALLA_SITE || {};

  function authUrl() {
    return String(cfg.AUTH_URL || "").replace(/\/$/, "");
  }

  function token() {
    return sessionStorage.getItem("valhalla-auth-token") || "";
  }

  async function api(path, options) {
    var headers = { accept: "application/json", authorization: "Bearer " + token() };
    if (options && options.body) headers["content-type"] = "application/json";
    var response = await fetch(authUrl() + path, Object.assign({
      credentials: "include",
      cache: "no-store",
      headers: headers
    }, options || {}));
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || "Request failed (HTTP " + response.status + ").");
    return body;
  }

  function note(id, text, state) {
    var node = document.getElementById(id);
    if (!node) return;
    node.textContent = text;
    if (state) node.dataset.state = state;
  }

  async function verifyOwner() {
    var button = document.getElementById("leaderOpen");
    var badge = document.getElementById("leaderBadge");
    if (!authUrl() || !token()) {
      owner = false;
      if (button) button.hidden = true;
      if (badge) badge.hidden = true;
      return false;
    }
    try {
      var result = await api("/auth/leader", { method: "POST", body: "{}" });
      owner = result.role === "leader";
    } catch (error) {
      owner = false;
      note("leaderStatus", "Owner verification failed. Sign in again and retry.", "error");
    }
    if (!owner && !document.getElementById("leadership").hidden) close();
    if (button) button.hidden = !owner;
    if (badge) badge.hidden = !owner;
    return owner;
  }

  function row(parent, label, value, state) {
    var item = document.createElement("div");
    item.className = "leader-row";
    item.setAttribute("role", "listitem");
    var name = document.createElement("span");
    name.textContent = label;
    var status = document.createElement("strong");
    status.textContent = value;
    if (state) status.dataset.state = state;
    item.appendChild(name);
    item.appendChild(status);
    parent.appendChild(item);
  }

  async function loadModel() {
    var select = document.getElementById("leaderModel");
    var save = document.getElementById("leaderSaveModel");
    if (!select || !save) return;
    select.disabled = true;
    save.disabled = true;
    try {
      var config = await api("/auth/chat-config");
      if (config.provider !== "openai" || !Array.isArray(config.models)) throw new Error("OpenAI model configuration is invalid.");
      models = config.models.filter(function (model) {
        return /^gpt-(4o-mini|4\.1-mini|4\.1-nano)$/.test(model);
      });
      if (!models.length || models.indexOf(config.model) < 0) throw new Error("No supported OpenAI model is available.");
      select.replaceChildren();
      models.forEach(function (model) {
        var option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        select.appendChild(option);
      });
      select.value = config.model;
      select.disabled = false;
      save.disabled = false;
      note("leaderModelNote", "Active model: " + config.model + ". No Llama provider is available in this control.", "ok");
    } catch (error) {
      note("leaderModelNote", "Model configuration unavailable: " + error.message, "error");
    }
  }

  async function saveModel() {
    var select = document.getElementById("leaderModel");
    var save = document.getElementById("leaderSaveModel");
    if (!owner || !select || models.indexOf(select.value) < 0) return;
    save.disabled = true;
    note("leaderModelNote", "Saving the shared model setting…", "loading");
    try {
      var result = await api("/auth/chat-config", {
        method: "POST",
        body: JSON.stringify({ model: select.value })
      });
      note("leaderModelNote", "Saved. The website assistant now uses " + result.model + ".", "ok");
    } catch (error) {
      note("leaderModelNote", "Model change failed: " + error.message, "error");
    } finally {
      save.disabled = false;
    }
  }

  function renderSystems(data) {
    var host = document.getElementById("leaderSystems");
    var rows = data && data.lines;
    host.replaceChildren();
    var checkedAt = Number(data && data.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt <= 0 || Date.now() - checkedAt > 15 * 60 * 1000) {
      note("leaderSystemsNote", "The last health report is missing or stale. System health is not reported as live.", "warning");
      return;
    }
    if (!Array.isArray(rows) || !rows.length) {
      note("leaderSystemsNote", "The status feed returned no system records.", "error");
      return;
    }
    rows.forEach(function (item) {
      if (!item || typeof item.name !== "string" ||
          ["LIVE", "DEGRADED", "OFFLINE"].indexOf(item.state) < 0) return;
      row(host, item.name, item.state, item.state.toLowerCase());
    });
    note("leaderSystemsNote", "Health values come from the configured public status feed; checks are not a guarantee of uptime.",
      host.childElementCount ? "ok" : "error");
  }

  async function loadSystems() {
    var url = String(cfg.STATUS_URL || "");
    if (!url) {
      document.getElementById("leaderSystems").replaceChildren();
      note("leaderSystemsNote", "No status feed is configured. System health is unreported, not assumed live.", "warning");
      return;
    }
    note("leaderSystemsNote", "Checking the configured status feed…", "loading");
    try {
      var response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("Status feed returned HTTP " + response.status + ".");
      renderSystems(await response.json());
    } catch (error) {
      document.getElementById("leaderSystems").replaceChildren();
      note("leaderSystemsNote", "Status unavailable: " + error.message, "error");
    }
  }

  function svgNode(name, attrs, text) {
    var item = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs || {}).forEach(function (key) { item.setAttribute(key, attrs[key]); });
    if (text) item.textContent = text;
    return item;
  }

  function renderEngagement(report) {
    var chart = document.getElementById("leaderEngagementChart");
    var table = document.getElementById("leaderEngagementTable");
    var days = report && Array.isArray(report.days) ? report.days : [];
    chart.replaceChildren();
    table.replaceChildren();
    if (!days.length) {
      note("leaderEngagementState", "No aggregate records are available.", "warning");
      chart.appendChild(svgNode("text", { x: 18, y: 82, class: "leader-chart-empty" }, "No opted-in engagement data yet"));
      return;
    }
    var maximum = Math.max(1, ...days.map(function (item) {
      return Math.max(Number(item.page_view) || 0, Number(item.chat_send) || 0);
    }));
    chart.appendChild(svgNode("line", { x1: 20, y1: 150, x2: 680, y2: 150, class: "leader-chart-axis" }));
    days.forEach(function (item, index) {
      var x = 30 + index * 94;
      var views = Number(item.page_view) || 0;
      var messages = Number(item.chat_send) || 0;
      var viewHeight = Math.round(108 * views / maximum);
      var messageHeight = Math.round(108 * messages / maximum);
      chart.appendChild(svgNode("rect", {
        x: x, y: 150 - viewHeight, width: 24, height: viewHeight, class: "leader-bar-views"
      }));
      chart.appendChild(svgNode("rect", {
        x: x + 28, y: 150 - messageHeight, width: 24, height: messageHeight, class: "leader-bar-chat"
      }));
      chart.appendChild(svgNode("text", { x: x, y: 174, class: "leader-chart-label" }, String(item.date || "").slice(5)));
      row(table, item.date || "Unknown date",
        "Views " + views + " · Ask " + messages + " · Paper starts " + (Number(item.paper_start) || 0));
    });
    note("leaderEngagementState", report.approximate
      ? "Approximate daily totals · consented signed-in activity"
      : "Aggregate daily totals", "ok");
  }

  async function loadEngagement() {
    note("leaderEngagementState", "Loading consented aggregate metrics…", "loading");
    try {
      renderEngagement(await api("/auth/engagement"));
    } catch (error) {
      note("leaderEngagementState", "Engagement data unavailable: " + error.message, "error");
    }
  }

  function renderPerformance() {
    var target = document.getElementById("leaderPerformance");
    target.replaceChildren();
    var nav = window.performance && performance.getEntriesByType
      ? performance.getEntriesByType("navigation")[0]
      : null;
    var values = nav ? [
      ["Page load", nav.duration, "ms"],
      ["Server response", nav.responseStart, "ms"],
      ["DOM ready", nav.domContentLoadedEventEnd, "ms"],
      ["Transferred", nav.transferSize, "bytes"]
    ] : [];
    if (!values.length) {
      target.textContent = "Browser timing data is not available in this session.";
      return;
    }
    values.forEach(function (item) {
      var term = document.createElement("dt");
      term.textContent = item[0];
      var detail = document.createElement("dd");
      detail.textContent = Number(item[1]).toFixed(0) + " " + item[2];
      target.appendChild(term);
      target.appendChild(detail);
    });
  }

  function renderPaper() {
    var paper = window.ValhallaPaper;
    var pause = document.getElementById("leaderPausePaper");
    var stop = document.getElementById("leaderStopPaper");
    if (!paper) {
      note("leaderPaperState", "Paper bot controls are unavailable on this page.", "warning");
      pause.disabled = true;
      stop.disabled = true;
      return;
    }
    var running = paper.running();
    note("leaderPaperState", "This browser’s paper bot is " +
      (running ? (paper.paused() ? "paused." : "running.") : "stopped."), running ? "ok" : "");
    pause.disabled = !running || paper.paused();
    stop.disabled = !running;
  }

  async function open() {
    note("leaderStatus", "Verifying owner session…", "loading");
    if (!(await verifyOwner())) {
      note("leaderStatus", "Owner verification required. Sign in with the authorized email and verify the email code.", "error");
      return;
    }
    document.getElementById("leadership").hidden = false;
    document.getElementById("desk").classList.add("manager-mode");
    document.getElementById("leaderOpen").setAttribute("aria-expanded", "true");
    note("leaderStatus", "Owner session verified · " + new Date().toLocaleString(), "ok");
    renderPerformance();
    renderPaper();
    await Promise.all([loadModel(), loadSystems(), loadEngagement()]);
  }

  function close() {
    document.getElementById("leadership").hidden = true;
    document.getElementById("desk").classList.remove("manager-mode");
    document.getElementById("leaderOpen").setAttribute("aria-expanded", "false");
  }

  document.getElementById("leaderOpen").addEventListener("click", open);
  document.getElementById("leaderClose").addEventListener("click", close);
  document.getElementById("leaderSaveModel").addEventListener("click", saveModel);
  document.getElementById("leaderRefresh").addEventListener("click", function () {
    if (!owner) return;
    loadSystems();
    loadEngagement();
    renderPerformance();
    renderPaper();
  });
  document.getElementById("leaderPausePaper").addEventListener("click", function () {
    if (owner && window.ValhallaPaper && window.ValhallaPaper.pause()) renderPaper();
  });
  document.getElementById("leaderStopPaper").addEventListener("click", function () {
    if (owner && window.ValhallaPaper) {
      window.ValhallaPaper.stop("Stopped from the leadership console. No order was sent.");
      renderPaper();
    }
  });

  window.addEventListener("valhalla-desk", verifyOwner);
  window.addEventListener("valhalla-desk", renderPaper);
  if (new URLSearchParams(window.location.search).get("view") === "admin") {
    window.addEventListener("valhalla-desk", open, { once: true });
  }
  verifyOwner();
})();
