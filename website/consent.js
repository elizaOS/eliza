(function (root) {
  var VERSION = 1;
  var KEY = "valhalla-consent";

  function read() {
    try {
      var data = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!data || data.v !== VERSION) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function write(choice) {
    var data = {
      v: VERSION,
      at: new Date().toISOString(),
      necessary: true,
      functional: choice.functional === true,
      analytics: choice.analytics === true,
      advertising: choice.advertising === true,
      gpc: navigator.globalPrivacyControl === true
    };
    if (data.gpc) {
      data.advertising = false;
      data.analytics = false;
    }
    localStorage.setItem(KEY, JSON.stringify(data));
    window.dispatchEvent(new Event("valhalla-consent"));
    document.cookie = "valhalla_consent=" + encodeURIComponent(JSON.stringify(data)) + "; Path=/; Max-Age=31536000; SameSite=Lax";
    apply(data);
    var banner = document.getElementById("consentBanner");
    if (banner) banner.hidden = true;
    return data;
  }

  function allows(category) {
    if (category === "necessary") return true;
    var data = read();
    if (!data) return false;
    if (navigator.globalPrivacyControl === true && (category === "advertising" || category === "analytics")) return false;
    return data[category] === true;
  }

  function apply(data) {
    var note = document.getElementById("gpcNote");
    if (note) note.hidden = !(data && data.gpc);
    if (data && data.advertising) loadAds();
  }

  function loadAds() {
    if (document.querySelector("script[data-valhalla-ads]")) return;
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6504655762357230";
    script.crossOrigin = "anonymous";
    script.setAttribute("data-valhalla-ads", "1");
    document.head.appendChild(script);
  }

  function banner() {
    if (document.getElementById("consentBanner")) return;
    var panel = document.createElement("section");
    panel.id = "consentBanner";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Cookie settings");
    panel.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:80;background:#0a0a0e;color:#f2ead8;border:1px solid #ffb347;padding:14px;font:13px/1.45 ui-monospace,monospace;max-width:720px";
    panel.innerHTML = '<p style="color:#ffb347;letter-spacing:.12em;margin:0 0 6px">VALHALLA™ · COOKIES</p>'
      + '<p id="gpcNote" hidden>Opt-out preference signal honored.</p>'
      + '<p>Strictly necessary cookies stay on. Analytics and advertising stay off until you allow them.</p>'
      + '<div id="consentCustom" hidden>'
      + '<label><input type="checkbox" checked disabled> Strictly necessary (always on)</label><br>'
      + '<label><input id="consentFunctional" type="checkbox"> Functional: Remember me on this device (masked email, sign-in method, wallet name, last 4, avatar initial, plan)</label><br>'
      + '<label><input id="consentAnalytics" type="checkbox"> Analytics</label><br>'
      + '<label><input id="consentAds" type="checkbox"> Advertising / affiliate</label>'
      + '</div>'
      + '<p style="display:flex;flex-wrap:wrap;gap:8px">'
      + '<button type="button" id="consentAll">Accept all</button>'
      + '<button type="button" id="consentReject">Reject non-essential</button>'
      + '<button type="button" id="consentCustomize">Customize</button>'
      + '<button type="button" id="consentSave" hidden>Save choices</button>'
      + '</p>'
      + '<p><a href="/privacy/">Privacy</a> · <a href="/cookies/">Cookies</a></p>';
    document.body.appendChild(panel);
    if (navigator.globalPrivacyControl === true) document.getElementById("gpcNote").hidden = false;
    document.getElementById("consentAll").onclick = function () {
      write({ functional: true, analytics: true, advertising: !navigator.globalPrivacyControl });
    };
    document.getElementById("consentReject").onclick = function () {
      write({ functional: false, analytics: false, advertising: false });
    };
    document.getElementById("consentCustomize").onclick = function () {
      document.getElementById("consentCustom").hidden = false;
      document.getElementById("consentSave").hidden = false;
    };
    document.getElementById("consentSave").onclick = function () {
      write({
        functional: document.getElementById("consentFunctional").checked,
        analytics: document.getElementById("consentAnalytics").checked,
        advertising: document.getElementById("consentAds").checked
      });
    };
  }

  function open() {
    banner();
    document.getElementById("consentBanner").hidden = false;
    document.getElementById("consentCustom").hidden = false;
    document.getElementById("consentSave").hidden = false;
  }

  function boot() {
    var data = read();
    if (navigator.globalPrivacyControl === true && (!data || data.advertising || data.analytics)) {
      data = write({ functional: data ? data.functional : false, analytics: false, advertising: false });
    }
    if (!data) banner();
    else apply(data);
    window.dispatchEvent(new Event("valhalla-consent"));
    document.querySelectorAll("[data-cookie-settings]").forEach(function (node) {
      node.addEventListener("click", function (event) {
        event.preventDefault();
        open();
      });
    });
  }

  root.ValhallaConsent = { allows: allows, open: open, read: read };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
