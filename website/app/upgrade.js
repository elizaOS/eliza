(function () {
  var USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

  function cfg() { return window.VALHALLA_SITE || {}; }

  function note(text) {
    var node = document.getElementById("payNote");
    if (node) node.textContent = text;
  }

  function open() {
    var modal = document.getElementById("upgradeModal");
    if (!modal || !modal.showModal) return;
    var shop = cfg();
    var other = document.getElementById("payOther");
    var live = document.getElementById("payLive");
    var hasOther = String(shop.COINBASE_COMMERCE_URL || shop.NOWPAYMENTS_URL || "").indexOf("https://") === 0;
    if (other) other.hidden = !hasOther;
    if (live) live.textContent = "Card checkout is available. Crypto checkout in SOL, USDC, or USDT uses the signed merchant address. Other coins stay hidden until a processor is connected. This is a subscription, not a deposit.";
    modal.showModal();
  }

  async function pay(kind) {
    if (kind === "card") {
      var url = cfg().LEMONSQUEEZY_CHECKOUT_URL || "";
      if (!url) {
        note("Checkout is temporarily unavailable. Please try again shortly. (V-PAY)");
        return;
      }
      window.open(url, "_blank", "noopener");
      note("The card checkout opened in a new tab. Pro turns on after the store confirms payment.");
      return;
    }
    if (kind === "other") {
      var alt = cfg().NOWPAYMENTS_URL || cfg().COINBASE_COMMERCE_URL || "";
      if (alt.indexOf("https://") !== 0) {
        note("That checkout is not available yet.");
        return;
      }
      window.open(alt, "_blank", "noopener");
      return;
    }
    try {
      var file = await fetch("/monetization.json").then(function (res) { return res.json(); });
      var address = String(file.cryptoReceiveAddress || "");
      var usdc = String(file.usdcMint || "");
      if (!address) {
        note("Checkout is temporarily unavailable. Please try again shortly. (V-PAY)");
        return;
      }
      var payUrl = "solana:" + address + "?label=Valhalla&message=Pro%20subscription";
      if (kind === "usdc" && usdc) payUrl += "&spl-token=" + encodeURIComponent(usdc) + "&amount=9.99";
      if (kind === "usdt") payUrl += "&spl-token=" + encodeURIComponent(USDT) + "&amount=9.99";
      note("This payment goes to the merchant address ending " + address.slice(-4) + ". It is a subscription, not a deposit. Not financial advice.");
      window.location.href = payUrl;
    } catch (err) {
      console.debug("valhalla", "V-PAY", String(err && err.message || err));
      note("Checkout is temporarily unavailable. Please try again shortly. (V-PAY)");
    }
  }

  function boot() {
    var openBtn = document.getElementById("upgradeBtn");
    if (openBtn) openBtn.addEventListener("click", open);
    document.querySelectorAll("[data-min-tier]").forEach(function (node) {
      if (node.disabled) node.title = "Upgrade";
      node.addEventListener("click", function (event) {
        if (!node.disabled) return;
        event.preventDefault();
        open();
      });
    });
    var card = document.getElementById("payCard");
    var sol = document.getElementById("paySol");
    var usdc = document.getElementById("payUsdc");
    var usdt = document.getElementById("payUsdt");
    var other = document.getElementById("payOther");
    if (card) card.addEventListener("click", function () { pay("card"); });
    if (sol) sol.addEventListener("click", function () { pay("sol"); });
    if (usdc) usdc.addEventListener("click", function () { pay("usdc"); });
    if (usdt) usdt.addEventListener("click", function () { pay("usdt"); });
    if (other) other.addEventListener("click", function () { pay("other"); });
    var toast = document.getElementById("newsToast");
    if (!toast) return;
    fetch("/changelog.json").then(function (res) { return res.json(); }).then(function (rows) {
      var latest = rows && rows[0];
      if (!latest) return;
      if (localStorage.getItem("valhalla-seen-update") === latest.date) return;
      toast.hidden = false;
      toast.textContent = "What's new: " + latest.text;
      localStorage.setItem("valhalla-seen-update", latest.date);
    }).catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
