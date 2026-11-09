(function () {
  var RPC = "https://api.mainnet-beta.solana.com";
  var TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var AGENT_KEY = "valhalla-agent-pubkey";
  var lastOk = 0;
  var journal = [];

  function keys() {
    try { return JSON.parse(localStorage.getItem("valhalla-device-keys") || "{}"); } catch (err) { return {}; }
  }
  function rpcUrl() {
    var custom = String(keys().rpc || "");
    return custom.indexOf("https://") === 0 ? custom : RPC;
  }
  function session() {
    try {
      var data = JSON.parse(localStorage.getItem("valhalla-session") || "{}");
      if (!data.at || Date.now() - data.at > 12 * 60 * 60 * 1000) return {};
      return data;
    } catch (err) { return {}; }
  }
  async function rpc(method, params) {
    var response = await fetch(rpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
    });
    var body = await response.json();
    if (!response.ok || body.error) throw new Error("lookup");
    return body.result;
  }
  function stamp(id, ok) {
    var node = document.getElementById(id);
    var when = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
    if (ok) lastOk = Date.now();
    if (node) node.textContent = (ok && Date.now() - lastOk < 45000 ? "live" : "stale") + " · last updated " + when + " ET";
  }
  async function paintWallet(address, solId, tokenId, emptyId) {
    var empty = document.getElementById(emptyId);
    if (!address) {
      if (empty) empty.hidden = false;
      return { sol: 0 };
    }
    if (empty) empty.hidden = true;
    var lamports = await rpc("getBalance", [address]);
    var sol = Number(lamports && lamports.value) / 1e9;
    var solNode = document.getElementById(solId);
    if (solNode) {
      solNode.hidden = false;
      solNode.textContent = (Number.isFinite(sol) ? sol.toFixed(4) : "0") + " SOL";
    }
    var owned = await rpc("getTokenAccountsByOwner", [address, { programId: TOKEN }, { encoding: "jsonParsed" }]);
    var rows = ((owned && owned.value) || []).slice(0, 8);
    var html = "";
    for (var i = 0; i < rows.length; i += 1) {
      var info = rows[i].account.data.parsed.info;
      var mint = String(info.mint || "");
      var amount = info.tokenAmount && info.tokenAmount.uiAmountString ? info.tokenAmount.uiAmountString : "0";
      var usd = "";
      if (keys().birdeye && mint) {
        try {
          var price = await fetch("https://public-api.birdeye.so/defi/price?address=" + encodeURIComponent(mint), { headers: { "X-API-KEY": keys().birdeye, "x-chain": "solana" } });
          var data = await price.json();
          if (data && data.data && Number.isFinite(Number(data.data.value))) usd = " · $" + Number(data.data.value).toFixed(4);
        } catch (err) { usd = ""; }
      }
      html += "<div>…" + mint.slice(-4) + " " + amount + usd + "</div>";
    }
    document.getElementById(tokenId).innerHTML = html || "<div>No SPL tokens</div>";
    return { sol: sol };
  }
  async function refresh() {
    var mine = session().pubkey || "";
    var agent = localStorage.getItem(AGENT_KEY) || "";
    var yours = { sol: 0 };
    var theirs = { sol: 0 };
    try {
      yours = await paintWallet(mine, "solLine", "tokenLines", "");
      stamp("yourFresh", true);
      document.getElementById("yourUpdated").textContent = "Last updated " + new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET";
    } catch (err) { stamp("yourFresh", false); }
    var empty = document.getElementById("agentEmpty");
    if (!agent || !window.ValhallaConnect.isPubkey(agent)) {
      empty.hidden = false;
      empty.textContent = "No agent wallet linked";
      document.getElementById("agentSol").hidden = true;
    } else {
      try {
        theirs = await paintWallet(agent, "agentSol", "agentTokens", "agentEmpty");
        stamp("agentFresh", true);
      } catch (err) { stamp("agentFresh", false); }
    }
    document.getElementById("combined").textContent = "Combined total " + (yours.sol + theirs.sol).toFixed(4) + " SOL. This adds the two wallets. It is not a profit figure.";
  }
  function db() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open("valhalla-ledger", 1);
      req.onupgradeneeded = function () {
        var store = req.result.createObjectStore("tx", { keyPath: "id" });
        store.createIndex("wallet", "wallet");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function saved(wallet) {
    var database = await db();
    return new Promise(function (resolve) {
      var rows = [];
      var req = database.transaction("tx").objectStore("tx").index("wallet").openCursor(IDBKeyRange.only(wallet));
      req.onsuccess = function () {
        var cursor = req.result;
        if (!cursor) { resolve(rows); return; }
        rows.push(cursor.value);
        cursor.continue();
      };
    });
  }
  async function put(row) {
    var database = await db();
    return new Promise(function (resolve) {
      var tx = database.transaction("tx", "readwrite");
      tx.objectStore("tx").put(row);
      tx.oncomplete = function () { resolve(); };
    });
  }
  async function clear(wallet) {
    var rows = await saved(wallet);
    var database = await db();
    await new Promise(function (resolve) {
      var tx = database.transaction("tx", "readwrite");
      rows.forEach(function (row) { tx.objectStore("tx").delete(row.id); });
      tx.oncomplete = function () { resolve(); };
    });
  }
  function renderHistory(rows) {
    var box = document.getElementById("history");
    if (!rows.length) { box.textContent = "No swaps saved yet for this wallet."; return; }
    box.innerHTML = rows.slice(0, 12).map(function (row) {
      return "<div>" + row.side + " …" + String(row.mint || "").slice(-4) + " " + row.amount + " · " + row.sol + " SOL · " + row.time + " · <a href=\"https://solscan.io/tx/" + row.signature + "\" target=\"_blank\" rel=\"noopener\">…" + row.signature.slice(-4) + "</a></div>";
    }).join("");
    var tokens = {};
    var wins = 0;
    var losses = 0;
    var sizes = { small: 0, mid: 0, large: 0 };
    var hours = {};
    rows.forEach(function (row) {
      tokens[row.mint] = (tokens[row.mint] || 0) + 1;
      if (row.side === "sell" && row.sol > 0) wins += 1;
      if (row.side === "sell" && row.sol < 0) losses += 1;
      var size = Math.abs(Number(row.sol) || 0);
      if (size < 0.1) sizes.small += 1;
      else if (size < 1) sizes.mid += 1;
      else sizes.large += 1;
      hours[row.hour] = (hours[row.hour] || 0) + 1;
    });
    var top = Object.keys(tokens).sort(function (a, b) { return tokens[b] - tokens[a]; }).slice(0, 3).map(function (mint) { return "…" + mint.slice(-4); }).join(", ");
    document.getElementById("pattern").textContent = "Your trading pattern (from on-chain history). Most traded: " + (top || "none") + ". Average hold time: not enough matched round trips. Size mix small " + sizes.small + ", mid " + sizes.mid + ", large " + sizes.large + ". Realized swap count wins " + wins + ", losses " + losses + ". This describes past chain activity. It does not improve results and it is not a promise of profit. Model output stays a DEMO until a backend exists. This history stays in this browser.";
  }
  async function scan(full) {
    var wallet = session().pubkey;
    if (!wallet) return;
    var known = full ? [] : await saved(wallet);
    var seen = {};
    known.forEach(function (row) { seen[row.signature] = true; });
    var sigs = await rpc("getSignaturesForAddress", [wallet, { limit: full ? 25 : 10 }]);
    for (var i = 0; i < sigs.length; i += 1) {
      var signature = sigs[i].signature;
      if (seen[signature]) break;
      var tx = await rpc("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      if (!tx || !tx.meta) continue;
      var keysList = (tx.transaction.message.accountKeys || []).map(function (key) { return key.pubkey || key; });
      var index = keysList.indexOf(wallet);
      if (index < 0) continue;
      var solDelta = (tx.meta.postBalances[index] - tx.meta.preBalances[index]) / 1e9;
      var pre = {};
      (tx.meta.preTokenBalances || []).forEach(function (row) { if (row.owner === wallet) pre[row.mint] = Number(row.uiTokenAmount.uiAmount || 0); });
      var post = {};
      (tx.meta.postTokenBalances || []).forEach(function (row) { if (row.owner === wallet) post[row.mint] = Number(row.uiTokenAmount.uiAmount || 0); });
      var mints = Object.keys(post).concat(Object.keys(pre));
      var mint = mints[0] || "";
      var delta = mint ? (post[mint] || 0) - (pre[mint] || 0) : 0;
      if (!mint || !delta) continue;
      var when = new Date((sigs[i].blockTime || 0) * 1000);
      await put({
        id: wallet + ":" + signature,
        wallet: wallet,
        signature: signature,
        mint: mint,
        side: delta > 0 ? "buy" : "sell",
        amount: Math.abs(delta),
        sol: solDelta,
        time: when.toLocaleString("en-US", { timeZone: "America/New_York" }),
        hour: when.getUTCHours()
      });
    }
    renderHistory(await saved(wallet));
  }
  function ads() {
    var pro = session().plan === "pro";
    var leader = document.getElementById("leaderBadge") && !document.getElementById("leaderBadge").hidden;
    var ok = window.ValhallaConsent && window.ValhallaConsent.allows("advertising") && !pro && !leader;
    ["adTop", "adSide"].forEach(function (id) {
      var node = document.getElementById(id);
      if (!node) return;
      node.hidden = !ok;
      if (ok) node.textContent = "Affiliate link · we may earn a commission. Valhalla™ house promo. Not trading advice.";
    });
  }
  function lab() {
    if (!window.Worker) return;
    var worker = new Worker("lab-worker.js");
    worker.onmessage = function (event) {
      journal = event.data.journal || journal;
      var row = document.createElement("div");
      row.textContent = event.data.line;
      document.getElementById("labFeed").prepend(row);
      document.getElementById("labStats").textContent = "SIMULATED paper cash " + Number(event.data.cash).toFixed(4) + ". Not a live result.";
    };
    document.getElementById("labExport").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(journal, null, 2)], { type: "application/json" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "valhalla-simulated-journal.json";
      link.click();
    });
  }
  document.getElementById("saveAgentWallet").addEventListener("click", function () {
    var value = document.getElementById("agentWallet").value.trim();
    if (value && !window.ValhallaConnect.isPubkey(value)) return;
    if (value) localStorage.setItem(AGENT_KEY, value);
    else localStorage.removeItem(AGENT_KEY);
    refresh();
  });
  document.getElementById("histRefresh").addEventListener("click", function () { scan(false); });
  document.getElementById("histRebuild").addEventListener("click", async function () {
    var wallet = session().pubkey;
    if (wallet) await clear(wallet);
    scan(true);
  });
  document.getElementById("histClear").addEventListener("click", async function () {
    var wallet = session().pubkey;
    if (wallet) await clear(wallet);
    renderHistory([]);
  });
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  window.setInterval(refresh, 20000);
  var wallet = session().pubkey;
  if (wallet) {
    refresh();
    saved(wallet).then(function (rows) { renderHistory(rows); if (!rows.length) scan(true); });
  }
  ads();
  lab();
})();
