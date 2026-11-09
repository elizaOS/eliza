(function () {
  var KEY = "valhalla-hive";
  var worker = null;
  var starting = false;
  var joining = false;

  function cfg() {
    return window.VALHALLA_SITE || {};
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (err) { return {}; }
  }

  function write(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function enabled() {
    return cfg().HIVE_ENABLED === true && String(cfg().HIVE_URL || "").indexOf("https://") === 0;
  }

  function say(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  function paint() {
    var state = read();
    var canRun = state.optIn === true && !joining && !starting && !worker && !document.hidden;
    ["hiveOpt", "hiveOptSettings"].forEach(function (id) {
      var box = document.getElementById(id);
      if (box) box.checked = state.optIn === true;
    });
    ["hiveRun", "hiveRunSettings"].forEach(function (id) {
      var button = document.getElementById(id);
      if (button) button.disabled = !canRun;
    });
    var slider = document.getElementById("hiveThrottle");
    if (slider) {
      slider.disabled = state.optIn !== true;
      if (state.cap) slider.value = String(state.cap);
    }
    var consentStatus = worker || starting
      ? "One simulated paper job is running. No follow-up job will start automatically."
      : joining
        ? "Connecting to the configured Hive service after your click…"
      : state.optIn
        ? "Consent is on for this tab. No job runs until you click Run one simulated job."
        : "Hive is off. Nothing runs until you opt in and click Run one simulated job.";
    say("hiveFlag", consentStatus);
    say("hiveFlagSettings", consentStatus);
    say("hiveMeter", "Impact: " + (state.optIn ? (state.paused ? "paused" : "on") : "off")
      + ". Jobs " + Number(state.jobs || 0)
      + ". Verified " + Number(state.verified || 0)
      + ". Engine " + (state.engine || "—")
      + ". CPU work-slice target " + (state.cap || 25) + "%; not a device-wide cap."
      + " Unverified results are not used.");
    say("hivePoints", "Contribution points: " + Number(state.points || 0) + ". Not transferable. No cash value.");
    var payout = document.getElementById("payoutLink");
    if (payout) payout.disabled = cfg().REWARDS_PAYOUT_ENABLED !== true;
    window.dispatchEvent(new CustomEvent("valhalla-hive-updated"));
  }

  function stop(reason) {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
    var state = read();
    state.active = false;
    write(state);
    paint();
    if (reason) say("hiveFlag", reason);
  }

  function pausedByDevice() {
    if (document.hidden) return "This tab is hidden. The Hive is paused.";
    var net = navigator.connection;
    if (net && (net.saveData || net.type === "cellular")) return "This connection is metered. The Hive is paused.";
    return "";
  }

  async function batteryPause() {
    if (!navigator.getBattery) return "";
    try {
      var battery = await navigator.getBattery();
      if (battery.charging === false) return "This device is on battery. The Hive is paused.";
    } catch (err) {
      return "";
    }
    return "";
  }

  function accountId() {
    var state = read();
    if (!state.accountId) {
      state.accountId = crypto.randomUUID();
      write(state);
    }
    return state.accountId;
  }

  async function finish(job, result) {
    var base = String(cfg().HIVE_URL || "").replace(/\/$/, "");
    var response = await fetch(base + "/hive/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodeId: read().nodeId,
        accountId: accountId(),
        jobId: job.id,
        cash: result.cash,
        n: result.n,
        simulated: true
      })
    });
    if (!response.ok) return false;
    var body = await response.json();
    if (!body || body.ok !== true || !Number.isFinite(Number(body.points))) return false;
    var state = read();
    state.points = Number(body.points);
    write(state);
    paint();
    return true;
  }

  async function nextJob() {
    var base = String(cfg().HIVE_URL || "").replace(/\/$/, "");
    var response = await fetch(base + "/hive/next", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: read().nodeId })
    });
    if (!response.ok) throw new Error("The Hive did not provide a job (HTTP " + response.status + ").");
    var job = await response.json();
    if (!job || job.simulated !== true || !job.id || !Array.isArray(job.series) || !job.params) {
      throw new Error("The Hive returned an invalid simulated job.");
    }
    return job;
  }

  async function runJob() {
    if (starting || worker || !read().optIn || !read().nodeId || !enabled()) return;
    starting = true;
    try {
      var why = pausedByDevice() || await batteryPause();
      if (why) {
        stop(why);
        return;
      }
      var job = await nextJob();
      if (!read().optIn || document.hidden) return;
      var current = new Worker("hive-worker.js");
      worker = current;
      current.onmessage = async function (event) {
        if (worker !== current) return;
        var result = event.data || {};
        var state = read();
        state.jobs = Number(state.jobs || 0) + 1;
        state.engine = "cpu";
        state.pending = result.jobId;
        write(state);
        try {
          if (await finish(job, result)) {
            state = read();
            state.verified = Number(state.verified || 0) + 1;
            write(state);
          } else {
            say("hiveFlag", "The Hive did not verify this result. It was not counted as verified.");
          }
        } catch (err) {
          say("hiveFlag", "Could not submit the simulated result. It was not counted as verified.");
        }
        current.terminate();
        worker = null;
        paint();
        if (read().optIn && !document.hidden) {
          nextTimer = setTimeout(function () {
            nextTimer = 0;
            runJob();
          }, 1000);
        }
      };
      current.onerror = function () {
        current.terminate();
        if (worker === current) worker = null;
        stop("The local simulated job failed. No result was submitted.");
      };
      current.postMessage({ job: job, cap: Number(read().cap) || 25, engine: "cpu" });
    } catch (err) {
      var state = read();
      state.optIn = false;
      state.active = false;
      write(state);
      stop("Hive work stopped: " + String(err && err.message || "the job could not be loaded"));
    } finally {
      starting = false;
      paint();
    }
  }

  async function join() {
    var token = "";
    var input = document.querySelector("[name='cf-turnstile-response']");
    if (input) token = input.value;
    if (!token) {
      say("hiveFlag", "A human check is required before you join.");
      return false;
    }
    var slider = document.getElementById("hiveThrottle");
    var cap = slider ? Number(slider.value) : 25;
    var response = await fetch(String(cfg().HIVE_URL).replace(/\/$/, "") + "/hive/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token, accountId: accountId() })
    });
    if (!response.ok) {
      say("hiveFlag", "The Hive did not accept this browser.");
      return false;
    }
    var body = await response.json();
    var state = read();
    if (!state.optIn || !body.nodeId) return false;
    state.active = true;
    state.nodeId = body.nodeId;
    state.cap = Math.min(50, Math.max(25, cap));
    write(state);
    paint();
    return true;
  }

  function setOpt(on) {
    var state = read();
    if (on !== true) {
      state.optIn = false;
      state.active = false;
      write(state);
      stop("Hive stopped.");
      return;
    }
    if (!enabled()) {
      state.optIn = false;
      state.active = false;
      write(state);
      paint();
      say("hiveFlag", "The Hive service is not configured. No work was started.");
      return;
    }
    var slider = document.getElementById("hiveThrottle");
    state.cap = slider ? Math.min(50, Math.max(25, Number(slider.value) || 25)) : 25;
    state.optIn = true;
    state.active = false;
    state.jobs = state.jobs || 0;
    state.verified = state.verified || 0;
    write(state);
    paint();
    say("hiveFlag", "Consent saved for this tab. No work or network request starts until you click Run one simulated job.");
  }

  async function runOnce() {
    if (!read().optIn || joining || starting || worker) return;
    joining = true;
    paint();
    try {
      var reason = pausedByDevice() || await batteryPause();
      if (reason) {
        say("hiveFlag", reason);
        return;
      }
      if (await join()) runJob();
    } catch (err) {
      say("hiveFlag", "Hive could not be joined: " + String(err && err.message || "request failed"));
    } finally {
      joining = false;
      paint();
    }
  }

  function boot() {
    var state = read();
    state.optIn = false;
    state.active = false;
    write(state);
    paint();
    ["hiveOpt", "hiveOptSettings"].forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      box.checked = false;
      box.addEventListener("change", function () { setOpt(box.checked); });
    });
    ["hiveRun", "hiveRunSettings"].forEach(function (id) {
      var button = document.getElementById(id);
      if (button) button.addEventListener("click", runOnce);
    });
    var slider = document.getElementById("hiveThrottle");
    if (slider) slider.addEventListener("input", function () {
      var next = read();
      next.cap = Math.min(50, Math.max(25, Number(slider.value) || 25));
      write(next);
      paint();
    });
    document.addEventListener("visibilitychange", function () {
      if (!read().optIn) return;
      if (document.hidden) {
        if (worker) worker.terminate();
        worker = null;
        var state = read();
        state.paused = true;
        write(state);
        say("hiveFlag", "This tab is hidden. The Hive is paused.");
        paint();
        return;
      }
      var state = read();
      state.paused = false;
      write(state);
      paint();
    });
    window.addEventListener("pagehide", function () { stop(); });
    if (navigator.getBattery) {
      navigator.getBattery().then(function (battery) {
        battery.addEventListener("chargingchange", function () {
          if (!battery.charging && read().optIn) stop("This device is on battery. The Hive is paused.");
          else if (battery.charging && read().optIn && !document.hidden) paint();
        });
      }).catch(function () {});
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
