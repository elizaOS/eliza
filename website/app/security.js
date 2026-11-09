(function () {
  var KEY = "valhalla-security";

  function cfg() {
    return window.VALHALLA_SITE || {};
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (err) { return {}; }
  }

  function base() {
    return String(cfg().AUTH_URL || "").replace(/\/$/, "");
  }

  function paintEmpty(text) {
    var devices = document.getElementById("deviceList");
    var signins = document.getElementById("signinList");
    if (devices) devices.textContent = text;
    if (signins) signins.textContent = "";
  }

  function when(ms) {
    if (!ms) return "";
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(ms)) + " ET";
  }

  function row(item, current) {
    var line = document.createElement("div");
    line.className = "device-row";
    var label = document.createElement("span");
    label.textContent = (item.browser || "browser") + " · " + (item.city || "unknown place") + " · " + when(item.last || item.created) + (current ? " · this device" : "");
    line.appendChild(label);
    if (!current) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = "Revoke";
      button.addEventListener("click", function () { revoke(item.id); });
      line.appendChild(button);
    }
    return line;
  }

  function load() {
    var box = document.getElementById("alwaysAsk");
    if (box && !box.dataset.bound) {
      box.dataset.bound = "1";
      box.checked = read().alwaysAsk === true;
      box.addEventListener("change", function () {
        var next = read();
        next.alwaysAsk = box.checked;
        localStorage.setItem(KEY, JSON.stringify(next));
        var url = base();
        var token = sessionStorage.getItem("valhalla-auth-token") || "";
        if (!url || !token) return;
        fetch(url + "/auth/security", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ alwaysAsk: box.checked })
        }).catch(function () {});
      });
    }
    if (!base()) {
      paintEmpty("Trusted devices appear after you sign in.");
      return;
    }
    var token = sessionStorage.getItem("valhalla-auth-token") || "";
    if (!token) {
      paintEmpty("Sign in to see trusted devices and recent sign-ins.");
      return;
    }
    fetch(base() + "/auth/devices", {
      credentials: "include",
      headers: { authorization: "Bearer " + token }
    }).then(function (res) { return res.json(); }).then(function (body) {
      var devices = document.getElementById("deviceList");
      var signins = document.getElementById("signinList");
      if (!body || !body.ok) {
        paintEmpty("The device list did not load.");
        return;
      }
      if (box) box.checked = body.alwaysAsk === true || box.checked;
      if (devices) {
        devices.textContent = "";
        if (!(body.devices || []).length) devices.textContent = "No trusted device yet.";
        (body.devices || []).forEach(function (item) { devices.appendChild(row(item, item.current)); });
      }
      if (signins) {
        signins.textContent = "";
        (body.signins || []).forEach(function (item) {
          var line = document.createElement("div");
          line.textContent = when(item.at) + " · " + (item.browser || "browser") + " · " + (item.city || "unknown place");
          signins.appendChild(line);
        });
      }
    }).catch(function () {
      paintEmpty("Trusted devices are temporarily unavailable. Please try again shortly. (V-AUTH)");
    });
  }

  function revoke(id) {
    fetch(base() + "/auth/devices/revoke", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + (sessionStorage.getItem("valhalla-auth-token") || "")
      },
      body: JSON.stringify({ id: id })
    }).then(load).catch(load);
  }

  function boot() {
    if (!document.getElementById("alwaysAsk")) return;
    load();
    var gear = document.getElementById("gear");
    if (gear) gear.addEventListener("click", load);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
