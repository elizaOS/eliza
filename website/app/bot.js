(function () {
  var ACCOUNT_KEY = "valhalla-account";

  function readAccount() {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "{}"); } catch (err) { return {}; }
  }

  function writeAccount(data) {
    data.at = Date.now();
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(data));
  }

  function log(line) {
    var box = document.getElementById("botLog");
    if (!box) return;
    var row = document.createElement("div");
    row.textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }) + " " + line;
    box.prepend(row);
  }

  function light(state) {
    var node = document.getElementById("botLight");
    if (!node) return;
    node.className = "light " + state;
    node.textContent = state === "running" ? "Running" : state === "error" ? "Error" : "Stopped";
  }

  function fields() {
    return {
      risk: document.getElementById("botRisk").value,
      maxSol: document.getElementById("botSize").value,
      slots: document.getElementById("botSlots").value,
      takeProfit: document.getElementById("botTp").value,
      stopLoss: document.getElementById("botSl").value,
      minLiquidity: document.getElementById("botLiq").value,
      minAgeHours: document.getElementById("botAge").value,
      copies: document.getElementById("botCopies").value.trim(),
      dailyLoss: document.getElementById("botLoss").value
    };
  }

  function apply(bot) {
    if (!bot) return;
    document.getElementById("botRisk").value = bot.risk || "medium";
    document.getElementById("botSize").value = bot.maxSol || "0.1";
    document.getElementById("botSlots").value = bot.slots || "3";
    document.getElementById("botTp").value = bot.takeProfit || "25";
    document.getElementById("botSl").value = bot.stopLoss || "15";
    document.getElementById("botLiq").value = bot.minLiquidity || "10000";
    document.getElementById("botAge").value = bot.minAgeHours || "1";
    document.getElementById("botCopies").value = bot.copies || "";
    document.getElementById("botLoss").value = bot.dailyLoss || "0.5";
  }

  var running = false;
  var paused = false;
  var timer = 0;
  var lastPrice = 0;
  var priceHistory = [];
  var yoloAccess = false;
  var yoloActive = false;
  var YOLO_PRESET = {
    risk: "high",
    maxSol: "0.25",
    slots: "5",
    takeProfit: "10",
    stopLoss: "8",
    minLiquidity: "10000",
    minAgeHours: "0.25",
    copies: "",
    dailyLoss: "0.25"
  };

  function liveTrading() {
    return (window.VALHALLA_SITE || {}).LIVE_TRADING === true;
  }

  function paintYolo() {
    var enable = document.getElementById("yoloEnable");
    var disable = document.getElementById("yoloDisable");
    var ack = document.getElementById("yoloRiskAck");
    var upgrade = document.getElementById("yoloUpgrade");
    if (enable) enable.disabled = !yoloAccess || !ack || !ack.checked || running || yoloActive;
    if (disable) {
      disable.hidden = !yoloActive;
      disable.disabled = running;
    }
    if (ack) {
      ack.disabled = !yoloAccess || yoloActive || running;
      if (!yoloActive && !yoloAccess) ack.checked = false;
    }
    if (upgrade) upgrade.hidden = yoloAccess;
  }

  function restoreYoloSettings(account) {
    if (account && account.yoloStandardBot) apply(account.yoloStandardBot);
    else apply(null);
  }

  function lockYolo(noteText) {
    var account = readAccount();
    var savedMode = account.bot && account.bot.mode === "yolo";
    if (yoloActive && running) stopPaper("YOLO access could not be verified; the paper run was stopped.");
    yoloActive = false;
    if (savedMode || account.yoloStandardBot) {
      restoreYoloSettings(account);
      account.bot = fields();
      delete account.bot.mode;
      delete account.yoloStandardBot;
      writeAccount(account);
    }
    var note = document.getElementById("yoloAccess");
    if (note) note.textContent = noteText;
    paintYolo();
    paintStart();
  }

  async function checkYoloAccess() {
    var note = document.getElementById("yoloAccess");
    var token = sessionStorage.getItem("valhalla-auth-token") || "";
    var base = String((window.VALHALLA_SITE || {}).AUTH_URL || "").replace(/\/$/, "");
    yoloAccess = false;
    if (!token || base.indexOf("https://") !== 0) {
      lockYolo("Sign in and verify an active Pro subscription to use YOLO. The account owner is also allowed.");
      return;
    }
    try {
      var response = await fetch(base + "/auth/access", {
        method: "GET",
        headers: { authorization: "Bearer " + token },
        credentials: "omit"
      });
      if (!response.ok) throw new Error("Access check returned HTTP " + response.status + ".");
      var access = await response.json();
      yoloAccess = access.subscriber === true || access.leader === true;
      var account = readAccount();
      if (yoloAccess) {
        if (note) note.textContent = access.leader
          ? "Owner access verified. YOLO stays paper-only."
          : "Pro subscription verified. YOLO stays paper-only.";
        if (account.bot && account.bot.mode === "yolo") apply(account.bot);
      } else {
        lockYolo(access.plan === "pro"
          ? "Access could not be verified for this account."
          : "YOLO is for Pro subscribers and the account owner. No Pro entitlement is recorded for this account; checkout alone does not unlock it.");
        return;
      }
    } catch (err) {
      lockYolo("Subscription access could not be verified. YOLO is locked. " + String(err && err.message || err));
      return;
    }
    paintYolo();
  }

  function enableYolo() {
    if (!yoloAccess || running) return;
    var account = readAccount();
    account.yoloStandardBot = fields();
    apply(YOLO_PRESET);
    account.bot = fields();
    account.bot.mode = "yolo";
    writeAccount(account);
    yoloActive = true;
    priceHistory = [];
    var note = document.getElementById("yoloAccess");
    if (note) note.textContent = "YOLO paper mode enabled. Signals are simulated; no orders or live-agent calls are made.";
    paintYolo();
    paintStart();
    log("YOLO paper preset enabled. No order will be sent.");
  }

  function disableYolo() {
    if (running) return;
    var account = readAccount();
    yoloActive = false;
    restoreYoloSettings(account);
    account.bot = fields();
    delete account.bot.mode;
    delete account.yoloStandardBot;
    writeAccount(account);
    priceHistory = [];
    var note = document.getElementById("yoloAccess");
    if (note) note.textContent = "Standard paper settings restored.";
    paintYolo();
    paintStart();
    log("YOLO paper mode disabled.");
  }

  function paintStart() {
    var account = readAccount();
    var start = document.getElementById("botStart");
    var note = document.getElementById("botLinkNote");
    var accepted = account.riskAccepted === true || document.getElementById("botRiskAck").checked;
    start.disabled = !accepted || running;
    if (note) {
      note.hidden = false;
      note.textContent = yoloActive
        ? "YOLO paper mode. Simulated signals only; live-agent calls are bypassed."
        : liveTrading()
        ? "Live-money trading is on. Start still needs your own agent. This website does not hold the key."
        : "Paper mode. Start uses live prices and sends no order. Live-money trading is off.";
    }
    ["botPause", "botResume"].forEach(function (id) {
      var node = document.getElementById(id);
      if (!node || (liveTrading() && !yoloActive)) return;
      node.disabled = false;
      node.title = id === "botPause" ? "Pause the paper run" : "Resume the paper run";
    });
    if (account.agentUrl) document.getElementById("botAgent").value = account.agentUrl;
    if (account.riskAccepted) document.getElementById("botRiskAck").checked = true;
  }

  function showPnl(text) {
    var node = document.getElementById("paperPnl");
    if (node) node.textContent = text;
  }

  async function callAgent(path) {
    var account = readAccount();
    var base = String(account.agentUrl || "").replace(/\/$/, "");
    if (!base) throw new Error("No agent is linked.");
    var response = await fetch(base + path, { method: path === "/api/state" ? "GET" : "POST", headers: { "content-type": "application/json" }, body: path === "/api/state" ? undefined : "{}" });
    if (!response.ok) throw new Error("The agent did not accept " + path);
    return response.json();
  }

  document.getElementById("botReview").addEventListener("click", function () {
    var bot = fields();
    var account = readAccount();
    account.bot = bot;
    writeAccount(account);
    var box = document.getElementById("botSummary");
    box.hidden = false;
    box.textContent = "Review: " + (yoloActive ? "YOLO paper mode, " : "") + "risk " + bot.risk + ", max " + bot.maxSol + " SOL, " + bot.slots + " open, take-profit " + bot.takeProfit + "%, stop " + bot.stopLoss + "%, min liquidity $" + bot.minLiquidity + ", min age " + bot.minAgeHours + "h, daily loss " + bot.dailyLoss + " SOL. Copy list: " + (bot.copies || "none") + ". This is not a promise of profit.";
    log("Settings saved on this account for review.");
  });

  document.getElementById("botRiskAck").addEventListener("change", function (event) {
    var account = readAccount();
    account.riskAccepted = event.target.checked;
    writeAccount(account);
    paintStart();
  });

  document.getElementById("botSaveAgent").addEventListener("click", function () {
    var account = readAccount();
    account.agentUrl = document.getElementById("botAgent").value.trim();
    writeAccount(account);
    paintStart();
    log(account.agentUrl ? "Agent link saved on this device." : "Agent link cleared.");
  });

  async function paperTick() {
    if (!running || paused) return;
    var price = 0;
    var source = "the live ticker";
    var feed = window.ValhallaTicker && window.ValhallaTicker.last && window.ValhallaTicker.last.sol;
    if (feed && Number(feed.usd)) price = Number(feed.usd);
    else {
      try {
        var response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true");
        var body = await response.json();
        price = Number(body.solana && body.solana.usd) || 0;
        source = "CoinGecko";
      } catch (err) {
        price = 0;
      }
    }
    var bot = fields();
    var move = lastPrice && price ? ((price - lastPrice) / lastPrice) : 0;
    lastPrice = price || lastPrice;
    if (!running || paused) return;
    var priceText = price ? "$" + price.toFixed(2) + " via " + source : "quiet";
    if (yoloActive && price) {
      priceHistory.push(price);
      if (priceHistory.length > 4) priceHistory.shift();
      var signal = window.ValhallaYoloLogic.signal(priceHistory, 0.0002);
      log("SIMULATED YOLO " + signal + ". SOL " + priceText + ". Candidate signal only; no order or position was created.");
      showPnl("SIMULATED YOLO signal: " + signal + ". No fill or profit/loss is simulated. Live-money trading is off.");
      return;
    }
    var skipped = Math.abs(move) < Number(bot.stopLoss) / 1000;
    if (skipped) log("SIMULATED skip. Live SOL price " + priceText + ". Not financial advice. No order was sent.");
    else log("SIMULATED mark only. Live SOL price " + priceText + ". Size cap " + bot.maxSol + " SOL. Not financial advice. No order was sent.");
    showPnl("SIMULATED result: flat. Live-money trading is off. Not financial advice.");
  }

  function startPaper() {
    running = true;
    paused = false;
    if (yoloActive) priceHistory = [];
    light("running");
    log("Paper run started. Live prices only. No order will be sent.");
    var positions = document.getElementById("paperPositions");
    if (positions) positions.textContent = "SAMPLE · flat · SIMULATED · not a live position";
    var chart = document.getElementById("paperChart");
    if (chart) {
      var ctx = chart.getContext("2d");
      ctx.strokeStyle = "#ffb347";
      ctx.beginPath();
      ctx.moveTo(0, 30);
      ctx.lineTo(40, 28);
      ctx.lineTo(80, 32);
      ctx.lineTo(120, 26);
      ctx.lineTo(160, 30);
      ctx.lineTo(200, 24);
      ctx.lineTo(280, 27);
      ctx.stroke();
    }
    paintStart();
    paintYolo();
    paperTick();
    timer = window.setInterval(paperTick, 20000);
  }

  function stopPaper(reason) {
    running = false;
    paused = false;
    window.clearInterval(timer);
    light("stopped");
    log(reason || "Paper run stopped. No order was sent.");
    paintStart();
    paintYolo();
  }

  function pausePaper() {
    if (!running || (liveTrading() && !yoloActive) || paused) return false;
    paused = true;
    log("Paper run paused. No order was sent.");
    return true;
  }

  document.getElementById("botStart").addEventListener("click", function () {
    var account = readAccount();
    if (!account.riskAccepted && !document.getElementById("botRiskAck").checked) {
      log("Tick the risk notice before the first start.");
      return;
    }
    account.bot = fields();
    if (yoloActive) account.bot.mode = "yolo";
    account.riskAccepted = true;
    writeAccount(account);
    if (yoloActive) {
      startPaper();
      return;
    }
    if (liveTrading()) {
      callAgent("/api/start").then(function () {
        light("running");
        log("Start sent to your agent. The key stayed on that computer.");
      }).catch(function () {
        light("error");
        log("Start failed. Your agent did not answer. No order was sent.");
      });
      return;
    }
    startPaper();
  });

  document.getElementById("botStop").addEventListener("click", function () {
    if (!liveTrading() || yoloActive) {
      stopPaper("Paper run stopped.");
      return;
    }
    callAgent("/api/stop").then(function () {
      light("stopped");
      log("Stop sent to your agent.");
    }).catch(function () {
      light("error");
      log("Stop failed. Your agent did not answer.");
    });
  });

  var pauseBtn = document.getElementById("botPause");
  if (pauseBtn) pauseBtn.addEventListener("click", function () {
    pausePaper();
  });
  var resumeBtn = document.getElementById("botResume");
  if (resumeBtn) resumeBtn.addEventListener("click", function () {
    if (!running || (liveTrading() && !yoloActive)) return;
    paused = false;
    log("Paper run resumed. Still simulated.");
  });

  var yoloAck = document.getElementById("yoloRiskAck");
  if (yoloAck) yoloAck.addEventListener("change", paintYolo);
  var yoloEnable = document.getElementById("yoloEnable");
  if (yoloEnable) yoloEnable.addEventListener("click", enableYolo);
  var yoloDisable = document.getElementById("yoloDisable");
  if (yoloDisable) yoloDisable.addEventListener("click", disableYolo);
  var yoloUpgrade = document.getElementById("yoloUpgrade");
  if (yoloUpgrade) yoloUpgrade.addEventListener("click", function () {
    var upgrade = document.getElementById("upgradeBtn");
    if (upgrade) upgrade.click();
  });

  var saved = readAccount();
  if (saved.bot && saved.bot.mode === "yolo") apply(saved.yoloStandardBot);
  else apply(saved.bot);
  paintStart();
  paintYolo();
  checkYoloAccess();
  window.addEventListener("focus", checkYoloAccess);
  light("stopped");
  window.ValhallaPaper = {
    running: function () { return running; },
    paused: function () { return paused; },
    start: startPaper,
    stop: stopPaper,
    pause: pausePaper,
    fields: fields,
    log: log
  };
  window.setInterval(function () {
    if (!liveTrading()) return;
    var account = readAccount();
    if (!account.agentUrl) return;
    callAgent("/api/state").then(function (body) {
      light(body && body.running ? "running" : "stopped");
    }).catch(function () {
      light("error");
    });
  }, 15000);
})();
