(function () {
  function boot() {
    if (!document.querySelector('script[src="/status.js"]')) {
      var statusScript = document.createElement("script");
      statusScript.src = "/status.js";
      document.head.appendChild(statusScript);
    }
    if (!document.querySelector('script[src="/app/ask.js"]')) {
      var ask = document.createElement("script");
      ask.src = "/app/ask.js";
      document.body.appendChild(ask);
    }
    if (!document.querySelector('script[src="/merch-promo.js"]')) {
      var merch = document.createElement("script");
      merch.src = "/merch-promo.js";
      document.body.appendChild(merch);
    }
    if (!window.ValhallaConsent && !document.querySelector('script[src="/consent.js"]')) {
      var consent = document.createElement("script");
      consent.src = "/consent.js";
      document.head.appendChild(consent);
    }
    var cfg = window.VALHALLA_SITE || {};
    var xUrl = cfg.xUrl || "https://x.com/intent/user?user_id=2092719999886475265";
    var mark = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.7 10.3 22 2h-2.2l-6.3 7.2L8.2 2H2l7.7 10.9L2 22h2.2l7-8 5.6 8H22l-7.3-11.7Z"/></svg>';
    var header = document.querySelector("header");
    if (!header) {
      header = document.createElement("header");
      header.className = "bar wrap";
      document.body.insertBefore(header, document.body.firstChild);
    }
    var brand = header.querySelector(".brand");
    if (!brand) {
      brand = document.createElement("a");
      brand.className = "brand";
      brand.href = "/";
      header.insertBefore(brand, header.firstChild);
    }
    if (brand.querySelector("img")) brand.querySelector("img").alt = "Valhalla™ mech logo";
    if (brand.innerHTML.indexOf("VALHALLA™") < 0) {
      if (brand.innerHTML.indexOf("VALHALLA") >= 0) brand.innerHTML = brand.innerHTML.replace("VALHALLA", "VALHALLA™");
      else brand.insertAdjacentHTML("beforeend", " VALHALLA™");
    }
    var nav = header.querySelector("nav") || header;
    var locked = header.dataset.nav === "locked";
    if (!locked && !header.querySelector(".xlink")) {
      var link = document.createElement("a");
      link.className = "xlink";
      link.href = xUrl;
      link.innerHTML = mark + " Follow Valhalla on X";
      nav.appendChild(link);
    }
    if (!locked && !header.querySelector('a[href="/shop/"]')) {
      var shop = document.createElement("a");
      shop.href = "/shop/";
      shop.textContent = "Shop";
      nav.appendChild(shop);
    }
    if (!locked && !header.querySelector('a[href="/contact/"]')) {
      var contact = document.createElement("a");
      contact.href = "/contact/";
      contact.textContent = "Contact";
      nav.appendChild(contact);
    }
    if (!document.getElementById("walletChip")) {
      var chip = document.createElement("span");
      chip.id = "walletChip";
      chip.hidden = true;
      nav.appendChild(chip);
    }
    var foot = document.querySelector("footer");
    if (!foot) {
      foot = document.createElement("footer");
      var wrap = document.createElement("div");
      wrap.className = "wrap";
      foot.appendChild(wrap);
      document.body.appendChild(foot);
    }
    var host = foot.querySelector(".wrap") || foot;
    if (!foot.querySelector(".xlink")) {
      var footX = document.createElement("p");
      footX.innerHTML = '<a class="xlink" href="' + xUrl + '">' + mark + " Follow Valhalla on X</a>";
      host.appendChild(footX);
    }
    if (!foot.querySelector("[data-cookie-settings]")) {
      var privacy = document.createElement("p");
      privacy.innerHTML = '<a href="/privacy/">Privacy</a> · <a href="/cookies/">Cookies</a> · <a href="#" data-cookie-settings>Cookie settings</a> · <a href="/privacy/#do-not-sell">Do Not Sell or Share My Personal Information</a> · <a href="/faq/">FAQ</a>';
      host.appendChild(privacy);
    }
    if (!foot.querySelector(".legal-tm")) {
      var legal = document.createElement("p");
      legal.className = "legal-tm";
      legal.textContent = "Valhalla™ and the Valhalla mech logo are trademarks of TokenJunction LLC.";
      host.appendChild(legal);
    }
    var meta = document.querySelector('meta[name="twitter:site"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "twitter:site");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", cfg.handle || "@ValhallaOS");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
