(function () {
  var KEYS = "valhalla-device-keys";
  var DISPLAY = "valhalla-display";
  var SESSION = "valhalla-session";

  function read(name) {
    try { return JSON.parse(localStorage.getItem(name) || "{}"); } catch (err) { return {}; }
  }

  function session() {
    var data = read(SESSION);
    if (!data.at || Date.now() - Number(data.at) > 12 * 60 * 60 * 1000) return {};
    return data;
  }

  function applyDisplay() {
    var display = read(DISPLAY);
    document.body.dataset.theme = display.theme === "day" ? "day" : "night";
    document.body.classList.toggle("compact", display.compact === true);
    var theme = document.getElementById("themePick");
    var compact = document.getElementById("compactPick");
    if (theme) theme.value = document.body.dataset.theme;
    if (compact) compact.checked = display.compact === true;
  }

  function fill() {
    var keys = read(KEYS);
    document.getElementById("keyBirdeye").value = keys.birdeye || "";
    document.getElementById("keyRpc").value = keys.rpc || "";
    document.getElementById("keyOtherName").value = keys.otherName || "";
    document.getElementById("keyOther").value = keys.otherKey || "";
    var who = session();
    var wallet = document.getElementById("setWallet");
    var share = document.getElementById("shareX");
    if (who.pubkey) {
      wallet.textContent = "Connected wallet …" + String(who.pubkey).slice(-4);
      share.hidden = false;
    } else {
      wallet.textContent = "No wallet connected.";
      share.hidden = true;
    }
    var google = document.getElementById("setGoogle");
    google.textContent = who.kind === "google"
      ? "Google: " + (who.hint || "connected")
      : "Google: not connected. Use Continue with Google on the sign-in step.";
  }

  function openPanel() {
    fill();
    document.getElementById("settings").hidden = false;
  }

  document.getElementById("gear").addEventListener("click", openPanel);
  document.getElementById("closeSettings").addEventListener("click", function () {
    document.getElementById("settings").hidden = true;
  });
  document.getElementById("setCopy").addEventListener("click", function () {
    var who = session();
    if (who.pubkey && navigator.clipboard) navigator.clipboard.writeText(who.pubkey);
  });
  document.getElementById("setDisconnect").addEventListener("click", function () {
    localStorage.removeItem(SESSION);
    localStorage.removeItem("valhalla-watch");
    location.href = "/app/";
  });
  document.getElementById("saveKeys").addEventListener("click", function () {
    var rpc = document.getElementById("keyRpc").value.trim();
    if (rpc && rpc.indexOf("https://") !== 0) rpc = "";
    localStorage.setItem(KEYS, JSON.stringify({
      birdeye: document.getElementById("keyBirdeye").value.trim(),
      rpc: rpc,
      otherName: document.getElementById("keyOtherName").value.trim(),
      otherKey: document.getElementById("keyOther").value.trim()
    }));
    window.dispatchEvent(new Event("valhalla-keys"));
  });
  var wipe = document.getElementById("deleteData");
  if (wipe) wipe.addEventListener("click", function () {
    var token = sessionStorage.getItem("valhalla-auth-token") || "";
    var base = String((window.VALHALLA_SITE || {}).AUTH_URL || "").replace(/\/$/, "");
    function finish() {
      localStorage.clear();
      sessionStorage.clear();
      document.cookie = "valhalla_consent=; Path=/; Max-Age=0";
      var note = document.getElementById("deleteNote");
      if (note) note.textContent = "Local data on this browser was cleared. To ask TokenJunction LLC to delete data held on a server, email hello@valhalla-app.xyz. This site does not keep a private key.";
    }
    if (!token || base.indexOf("https://") !== 0) {
      finish();
      return;
    }
    fetch(base + "/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { authorization: "Bearer " + token }
    }).then(finish, finish);
  });
  document.getElementById("deleteKeys").addEventListener("click", function () {
    localStorage.removeItem(KEYS);
    fill();
    window.dispatchEvent(new Event("valhalla-keys"));
  });
  document.getElementById("shareX").addEventListener("click", function () {
    var text = "I just set up my Valhalla™ desk https://valhalla-app.xyz";
    window.open("https://x.com/intent/post?text=" + encodeURIComponent(text), "_blank", "noopener");
  });
  document.getElementById("themePick").addEventListener("change", function (event) {
    var display = read(DISPLAY);
    display.theme = event.target.value;
    localStorage.setItem(DISPLAY, JSON.stringify(display));
    applyDisplay();
  });
  document.getElementById("compactPick").addEventListener("change", function (event) {
    var display = read(DISPLAY);
    display.compact = event.target.checked;
    localStorage.setItem(DISPLAY, JSON.stringify(display));
    applyDisplay();
  });
  applyDisplay();
})();
