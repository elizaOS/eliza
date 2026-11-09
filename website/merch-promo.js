(function () {
  var KEY = "valhalla-merch-until";
  var DAYS = 14 * 24 * 60 * 60 * 1000;

  function cfg() {
    var site = window.VALHALLA_SITE || {};
    return site.shop || {};
  }

  function hiddenUntil() {
    var until = Number(localStorage.getItem(KEY) || 0);
    return until > Date.now();
  }

  function proUser() {
    try {
      var account = JSON.parse(localStorage.getItem("valhalla-account") || "{}");
      if (account.plan === "pro" || account.plan === "leader") return true;
    } catch (err) { /* keep going */ }
    var badge = document.getElementById("leaderBadge");
    return Boolean(badge && !badge.hidden);
  }

  function signingIn() {
    var path = location.pathname;
    if (path === "/connect" || path.indexOf("/connect/") === 0) return true;
    if (document.body && document.body.dataset.page === "app") {
      var desk = document.getElementById("desk");
      if (!desk || desk.hidden) return true;
    }
    return false;
  }

  function remember() {
    localStorage.setItem(KEY, String(Date.now() + DAYS));
  }

  function closeCard(card, opener) {
    if (!card) return;
    card.remove();
    remember();
    document.removeEventListener("keydown", card._onKey);
    if (opener && opener.focus) opener.focus();
  }

  function show() {
    var shop = cfg();
    if (shop.enabled !== true || String(shop.url || "").indexOf("https://") !== 0) return;
    if (hiddenUntil() || signingIn() || proUser() || document.getElementById("merchOffer")) return;
    var code = String(shop.code || "VALHALLA25");
    var opener = document.activeElement;
    var card = document.createElement("aside");
    card.id = "merchOffer";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-label", "Valhalla merch offer");
    card.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:70;width:min(320px,calc(100% - 32px));background:#0a0a0e;color:#f2ead8;border:1px solid #ffb347;padding:12px;font:13px/1.4 ui-monospace,monospace;box-shadow:0 0 24px rgba(0,0,0,.45)";
    card.innerHTML = '<img src="/assets/mark.svg" alt="" width="36" height="36">'
      + '<p id="merchText"></p>'
      + '<p style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<a id="merchShop" class="btn" href="">Shop now</a>'
      + '<button type="button" id="merchClose">Not now</button></p>';
    document.body.appendChild(card);
    document.getElementById("merchText").textContent = "Valhalla merch is here: 25% off your first order over $15.99 with code " + code;
    var link = document.getElementById("merchShop");
    link.href = shop.url;
    link.setAttribute("aria-label", "Shop now");
    var closer = document.getElementById("merchClose");
    closer.setAttribute("aria-label", "Dismiss merch offer");
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCard(card, opener);
        return;
      }
      if (event.key !== "Tab") return;
      var nodes = [link, closer];
      var first = nodes[0];
      var last = nodes[1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    card._onKey = onKey;
    document.addEventListener("keydown", onKey);
    closer.addEventListener("click", function () { closeCard(card, opener); });
    closer.focus();
    remember();
  }

  function arm() {
    var shop = cfg();
    if (shop.enabled !== true || String(shop.url || "").indexOf("https://") !== 0) return;
    if (hiddenUntil() || signingIn()) return;
    var opened = false;
    function tryShow() {
      if (opened || signingIn() || proUser()) return;
      opened = true;
      show();
    }
    window.setTimeout(tryShow, 10000);
    window.addEventListener("scroll", function () {
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      if (max > 0 && window.scrollY / max >= 0.5) tryShow();
    }, { passive: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm);
  else arm();
})();
