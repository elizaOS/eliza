(function (root) {
  var standard = [];
  var ICONS = {
    phantom: '<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#AB9FF2"/><path fill="#fff" d="M9 15c0-4 3-7 7-7s7 3 7 7v7l-2.2-1.6L18.2 22 16 20.2 13.8 22 11.2 20.4 9 22v-7z"/></svg>',
    solflare: '<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1a120c"/><path fill="#FC7227" d="M16 5c2 4 1 6 4 9 2 2 4 4 4 8a8 8 0 1 1-14 0c0-3 2-5 3-8 1-2 1-5 3-9z"/></svg>',
    backpack: '<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#E33E3F"/><path fill="#fff" d="M12 8h8v3h2v14H10V11h2V8zm2 2v1h4v-1h-4z"/></svg>',
    other: '<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2c281f"/><circle cx="16" cy="16" r="6" fill="#ffb347"/></svg>'
  };

  function register() {
    var wallets = Array.prototype.slice.call(arguments);
    wallets.forEach(function (wallet) {
      if (wallet && wallet.features && standard.indexOf(wallet) < 0) standard.push(wallet);
    });
    return function () {
      wallets.forEach(function (wallet) { var i = standard.indexOf(wallet); if (i >= 0) standard.splice(i, 1); });
    };
  }
  var walletApp = Object.freeze({ register: register });
  window.addEventListener("wallet-standard:register-wallet", function (event) {
    if (typeof event.detail === "function") event.detail(walletApp);
  });

  function injected(id) {
    if (id === "phantom") return window.phantom && window.phantom.solana;
    if (id === "solflare") return window.solflare || null;
    if (id === "backpack") return window.backpack || null;
    return null;
  }

  function otherWallet() {
    return standard.find(function (wallet) {
      return !root.ValhallaConnect.pickNamed([wallet], "phantom")
        && !root.ValhallaConnect.pickNamed([wallet], "solflare")
        && !root.ValhallaConnect.pickNamed([wallet], "backpack");
    }) || null;
  }

  function mobile() {
    return /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  }

  function toB64(bytes) {
    var raw = "";
    for (var i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
    return btoa(raw);
  }

  function tellExtension(payload) {
    var ext = new URLSearchParams(location.search).get("ext");
    window.postMessage(payload, location.origin);
    if (ext && window.chrome && chrome.runtime && chrome.runtime.sendMessage) chrome.runtime.sendMessage(ext, payload, function () {});
  }

  function paintChip(pubkey) {
    var slot = document.getElementById("walletChip");
    if (!slot) return;
    slot.hidden = false;
    slot.textContent = "";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "…" + String(pubkey).slice(-4);
    var menu = document.createElement("div");
    menu.hidden = true;
    var copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy address";
    copy.addEventListener("click", function () { if (navigator.clipboard) navigator.clipboard.writeText(pubkey); });
    var view = document.createElement("a");
    view.href = "/app/";
    view.textContent = "View balances";
    var bye = document.createElement("button");
    bye.type = "button";
    bye.textContent = "Disconnect";
    bye.addEventListener("click", function () {
      localStorage.removeItem("valhalla-watch");
      sessionStorage.removeItem("valhalla-siws");
      slot.hidden = true;
    });
    menu.appendChild(copy);
    menu.appendChild(view);
    menu.appendChild(bye);
    button.addEventListener("click", function () { menu.hidden = !menu.hidden; });
    slot.appendChild(button);
    slot.appendChild(menu);
    var tail = document.getElementById("ownTail");
    if (tail) tail.textContent = "…" + String(pubkey).slice(-4);
  }

  function finish(adapter) {
    if (!adapter) throw new Error("That wallet is not available in this tab.");
    var now = Date.now();
    return root.ValhallaConnect.signInWithAdapter(adapter, root.nacl, {
      domain: location.host,
      nonce: crypto.randomUUID(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 5 * 60 * 1000).toISOString()
    }).then(function (proof) {
      var packed = root.ValhallaConnect.handoff(proof, toB64(proof.signature));
      sessionStorage.setItem("valhalla-siws", JSON.stringify({ pubkey: packed.pubkey, message: packed.message, signature: packed.signature }));
      localStorage.setItem("valhalla-watch", packed.pubkey);
      tellExtension(packed);
      paintChip(packed.pubkey);
      window.dispatchEvent(new CustomEvent("valhalla-signed", { detail: packed }));
      return packed;
    });
  }

  function continueWith(id) {
    var provider = id === "other" ? null : injected(id);
    var named = id === "other" ? otherWallet() : root.ValhallaConnect.pickNamed(standard, id);
    var installed = root.ValhallaConnect.hasInjectedProvider(provider) || root.ValhallaConnect.hasStandardWallet(named);
    var step = root.ValhallaConnect.walletStep(id, { installed: installed, mobile: mobile(), pageUrl: location.href });
    if (step.action === "browse") {
      location.href = step.url;
      return Promise.resolve();
    }
    if (step.action === "install") {
      window.open(step.url, "_blank", "noopener");
      return Promise.resolve();
    }
    if (step.action !== "connect") {
      return Promise.reject(new Error("No other wallet was detected."));
    }
    var pending = provider && typeof provider.connect === "function" && typeof provider.signMessage === "function"
      ? root.ValhallaConnect.adapterFromInjected(provider, id)
      : root.ValhallaConnect.adapterFromStandard(named);
    return pending.then(finish);
  }

  function mountButtons(host) {
    if (!host || host.dataset.ready === "1") return;
    host.dataset.ready = "1";
    host.classList.add(host.id === "loginButtons" ? "login-stack" : "wallet-row");
    root.ValhallaConnect.walletChoices().forEach(function (choice) {
      var button = document.createElement("button");
      button.type = "button";
      button.innerHTML = (ICONS[choice.id] || "") + "<span>" + choice.label + "</span>";
      button.className = "valhalla-wallet-button";
      button.dataset.wallet = choice.id;
      button.style.cssText = "display:flex;align-items:center;justify-content:flex-start;gap:12px;width:100%;min-height:48px;padding:12px 16px;margin:8px 0;border:1px solid #a67c3e;border-radius:10px;background:#171b22;color:#f4ead8;font:600 16px system-ui;cursor:pointer";
      button.addEventListener("click", function () {
        if (host.dataset.busy === "1") return;
        host.dataset.busy = "1";
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        var label = button.querySelector("span");
        label.textContent = "Opening " + (choice.id === "other" ? "wallet" : choice.id) + "...";
        var note = document.getElementById("walletNote") || document.getElementById("loginNote");
        if (note) { note.setAttribute("role", "status"); note.textContent = "Approve the connection and sign-in message in your wallet. No transaction is requested."; }
        var pending;
        try { pending = continueWith(choice.id); } catch (err) { pending = Promise.reject(err); }
        Promise.resolve(pending).then(function (proof) {
          if (note) note.textContent = proof && proof.pubkey ? "Wallet connected: ..." + proof.pubkey.slice(-4) : "Wallet app or download page opened. Return here to continue.";
        }).catch(function (err) {
          if (note) note.textContent = err && err.message ? err.message : "Connection was not completed. You can try again.";
        }).finally(function () {
          host.dataset.busy = "0";
          button.disabled = false;
          button.removeAttribute("aria-busy");
          label.textContent = choice.label;
        });
      });
      host.appendChild(button);
    });
  }

  root.ValhallaSite = { mountButtons: mountButtons, continueWith: continueWith };

  function boot() {
    if (document.body && document.body.dataset.marketing === "1") return;
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: walletApp }));
    var stack = document.getElementById("loginButtons");
    if (stack && document.body.dataset.page !== "app") mountButtons(stack);
    var watch = localStorage.getItem("valhalla-watch");
    if (watch && root.ValhallaConnect.isPubkey(watch)) paintChip(watch);
    var asked = new URLSearchParams(location.search).get("wallet");
    if (asked && document.body.dataset.page !== "app") continueWith(asked).catch(function () {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(typeof globalThis !== "undefined" ? globalThis : this);
