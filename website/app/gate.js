(function () {
  var HUMAN_KEY = "valhalla-human";
  var SESSION_KEY = "valhalla-session";
  var HUMAN_MS = 30 * 60 * 1000;
  var cfg = window.VALHALLA_SITE || {};
  var RPC = "https://api.mainnet-beta.solana.com";
  var TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var clockTimer = 0;

  function show(id) {
    ["gateHuman", "gateTerms", "gateAccount", "gateCode", "gateWallet", "desk"].forEach(function (name) {
      var node = document.getElementById(name);
      if (node) node.hidden = name !== id;
    });
    var boot = document.getElementById("mechaBoot");
    if (boot) boot.hidden = true;
  }

  function maskEmail(email) {
    var parts = String(email || "").toLowerCase().split("@");
    if (parts.length !== 2 || !parts[0]) return "there";
    return parts[0].slice(0, 1) + "***@" + parts[1];
  }

  function readRemember() {
    try { return JSON.parse(localStorage.getItem("valhalla-remember") || "null"); } catch (err) { return null; }
  }

  function saveRemember(account, method) {
    var box = document.getElementById("rememberMe");
    var consent = !window.ValhallaConsent || window.ValhallaConsent.allows("functional");
    if (!box || !box.checked || !consent) return;
    var name = account.walletPref || "Wallet";
    localStorage.setItem("valhalla-remember", JSON.stringify({
      mask: account.hint || maskEmail(account.email),
      method: method,
      walletName: name,
      last4: account.wallet ? String(account.wallet).slice(-4) : "",
      initial: String(account.hint || "V").slice(0, 1).toUpperCase(),
      tier: account.plan || "free"
    }));
  }

  function forgetDevice() {
    localStorage.removeItem("valhalla-remember");
    var welcome = document.getElementById("welcomeBack");
    if (welcome) welcome.hidden = true;
  }

  function fresh(raw, maxAge) {
    try {
      var data = JSON.parse(raw || "null");
      if (!data || !data.at) return null;
      if (Date.now() - Number(data.at) > maxAge) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  var ACCOUNT_KEY = "valhalla-account";

  function readAccount() {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null"); } catch (err) { return null; }
  }

  function writeAccount(data) {
    data.at = Date.now();
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(data));
  }

  function markHuman() {
    sessionStorage.setItem(HUMAN_KEY, JSON.stringify({ ok: true, at: Date.now() }));
    var version = String(cfg.TERMS_VERSION || "2026-11-03");
    if (sessionStorage.getItem("valhalla-terms-session") === version) {
      show("gateAccount");
      mountAccount();
      return;
    }
    show("gateTerms");
    mountTerms();
  }

  function mountTerms() {
    var box = document.getElementById("termsAgree");
    var save = document.getElementById("termsSave");
    var end = document.getElementById("termsEnd");
    var scroller = document.getElementById("termsScroll");
    if (!box || !save || !end || !scroller || scroller.dataset.bound) return;
    scroller.dataset.bound = "1";
    box.disabled = true;
    save.disabled = true;
    var seen = false;
    var watcher = new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) {
        seen = true;
        box.disabled = false;
        save.disabled = false;
      }
    }, { root: scroller, threshold: 0.9 });
    watcher.observe(end);
    save.addEventListener("click", function () {
      if (!seen || !box.checked) return;
      var version = String(cfg.TERMS_VERSION || "2026-11-03");
      var receipt = { version: version, at: new Date().toISOString(), method: "scroll-to-end clickwrap" };
      localStorage.setItem("valhalla-terms-receipt", JSON.stringify(receipt));
      sessionStorage.setItem("valhalla-terms-session", version);
      show("gateAccount");
      mountAccount();
    });
  }

  function keyReady(value) {
    return value && value.indexOf("NOT_SET") < 0;
  }

  function mountTurnstile() {
    var note = document.getElementById("humanNote");
    var placeholder = document.getElementById("humanPlaceholder");
    if (!keyReady(cfg.TURNSTILE_SITE_KEY)) {
      if (note) ValhallaErrors.show(note, { code: "V-GATE", public: "The human check is temporarily unavailable. Please try again shortly.", detail: "turnstile key missing" });
      if (placeholder) {
        placeholder.hidden = false;
      }
      return;
    }
    var script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = function () {
      window.turnstile.render("#turnstile", {
        sitekey: cfg.TURNSTILE_SITE_KEY,
        action: "valhalla-signin",
        appearance: "interaction-only",
        callback: function (token) {
          function accept(body) {
            if (body && body.human) sessionStorage.setItem("valhalla-human-proof", body.human);
            markHuman();
          }
          function legacy() {
            fetch(cfg.TURNSTILE_VERIFY_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token: token })
            }).then(function (res) { return res.json(); }).then(function (body) {
              if (body && body.ok) markHuman();
              else if (note) note.textContent = "The human check was not confirmed.";
            }).catch(function () {
              if (note) ValhallaErrors.show(note, { code: "V-GATE", public: "The human check is temporarily unavailable. Please try again shortly.", detail: "turnstile verify failed", retry: function () { location.reload(); } });
            });
          }
          if (!authBase()) {
            legacy();
            return;
          }
          fetch(authBase() + "/auth/human", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: token })
          }).then(function (res) {
            return res.json().catch(function () { return { ok: false }; }).then(function (body) {
              body.status = res.status;
              return body;
            });
          }).then(function (body) {
            if (body && body.ok) {
              accept(body);
              return;
            }
            if (body && body.status === 403) {
              if (note) note.textContent = "The human check was not confirmed.";
              return;
            }
            legacy();
          }).catch(function () {
            legacy();
          });
        }
      });
    };
    script.onerror = function () {
      if (note) ValhallaErrors.show(note, { code: "V-GATE", public: "The human check is temporarily unavailable. Please try again shortly.", detail: "turnstile script failed to load", retry: function () { location.reload(); } });
    };
    document.head.appendChild(script);
  }

  function termsOk() {
    var version = String(cfg.TERMS_VERSION || "2026-11-03");
    if (sessionStorage.getItem("valhalla-terms-session") === version) return true;
    var box = document.getElementById("termsAgree");
    if (box && box.checked && !box.disabled) return true;
    var note = document.getElementById("accountNote");
    if (note) note.textContent = "Please accept the terms before you sign in.";
    return false;
  }

  function authBase() {
    return String(cfg.AUTH_URL || "").replace(/\/$/, "");
  }

  function alwaysAsk() {
    try { return JSON.parse(localStorage.getItem("valhalla-security") || "{}").alwaysAsk === true; }
    catch (err) { return false; }
  }

  function fail(el, code, detail, retry) {
    var message = "Sign-in is temporarily unavailable. Please try again shortly.";
    ValhallaErrors.show(el, { code: code, public: message, detail: detail, retry: retry });
    var screen = document.getElementById("mechaError");
    var text = document.getElementById("mechaErrorText");
    var codeNode = document.getElementById("mechaErrorCode");
    var button = document.getElementById("mechaRetry");
    if (!screen || !button) return;
    if (text) text.textContent = message;
    if (codeNode) codeNode.textContent = code;
    button.onclick = function () {
      screen.hidden = true;
      if (retry) retry();
    };
    screen.hidden = false;
  }

  function authNote(error) {
    if (error === "rate") return "Please wait a moment, then ask for a new code.";
    if (error === "locked") return "That code was tried too many times. Ask for a new one.";
    if (error === "expired" || error === "code" || error === "missing") return "That code was not accepted.";
    if (error === "nonce" || error === "replay") return "Please try that sign-in step again.";
    if (error === "turnstile") return "The human check was not confirmed.";
    return "";
  }

  function showCode(hint, next, pending) {
    sessionStorage.removeItem("valhalla-pending-email");
    if (pending) sessionStorage.setItem("valhalla-pending", pending);
    sessionStorage.setItem("valhalla-code-next", next);
    var lead = document.getElementById("codeLead");
    if (lead) lead.textContent = "Enter the 6-digit code sent to " + (hint || "your email") + ". It expires in 10 minutes.";
    show("gateCode");
    var input = document.getElementById("emailCodeInput");
    if (input) input.focus();
  }

  function acceptAccount(body) {
    var prior = readAccount() || {};
    var account = {
      hint: body.hint || prior.hint || "",
      wallet: prior.wallet || "",
      walletPref: prior.walletPref || "",
      method: prior.method || body.method || "email",
      agentUrl: prior.agentUrl || "",
      bot: prior.bot || null,
      riskAccepted: prior.riskAccepted === true,
      termsAccepted: true,
      plan: prior.plan || "free"
    };
    writeAccount(account);
    sessionStorage.setItem("valhalla-auth", "1");
    sessionStorage.removeItem("valhalla-pending-email");
    saveRemember(account, account.method);
    if (body.session) sessionStorage.setItem("valhalla-auth-token", body.session);
    if (body.needCode) {
      sessionStorage.removeItem("valhalla-code-ok");
      showCode(body.hint || account.hint, "wallet", body.pending);
    } else {
      sessionStorage.setItem("valhalla-code-ok", "1");
      saveSession(accountSession(account));
      if (body.redirect === "/admin/master-control/") {
        sessionStorage.removeItem("valhalla-entry-desk");
        window.location.assign(body.redirect);
        return;
      }
      if (sessionStorage.getItem("valhalla-entry-desk") === "1") {
        sessionStorage.removeItem("valhalla-entry-desk");
        window.location.assign("/os/");
        return;
      }
      if (body.redirect === "/dashboard/analytics/") {
        window.location.assign(body.redirect);
        return;
      }
      openDesk();
    }
  }

  function verifyGoogle(credential, note) {
    if (!credential) {
      fail(note, "V-AUTH", "empty google credential", function () { location.reload(); });
      return;
    }
    fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential))
      .then(function (res) { return res.json().then(function (body) { body.httpOk = res.ok; return body; }); })
      .then(function (info) {
        var iss = String(info.iss || "");
        var verified = info.email_verified === true || info.email_verified === "true";
        var audOk = info.aud === cfg.GOOGLE_CLIENT_ID;
        var issOk = iss === "https://accounts.google.com" || iss === "accounts.google.com";
        if (!info.httpOk || !audOk || !issOk || Number(info.exp) * 1000 < Date.now() || !verified || !info.email) {
          fail(note, "V-AUTH", "google token rejected", function () { location.reload(); });
          return;
        }
        var prior = readAccount() || {};
        writeAccount({
          hint: prior.hint || "",
          wallet: prior.wallet || "",
          walletPref: prior.walletPref || "",
          method: "google",
          agentUrl: prior.agentUrl || "",
          bot: prior.bot || null,
          riskAccepted: prior.riskAccepted === true,
          termsAccepted: true,
          plan: prior.plan || "free"
        });
        if (!authBase()) {
          showCode("your email", "wallet");
          fail(document.getElementById("emailCodeError"), "V-MAIL", "code service unavailable", function () { location.reload(); });
          return;
        }
        postAuth("/auth/google", { credential: credential, alwaysAsk: alwaysAsk() }).then(function (body) {
          if (!body.ok) {
            var friendly = authNote(body.error);
            if (friendly) note.textContent = friendly;
            else fail(note, "V-AUTH", "google worker " + (body.error || ""), function () { verifyGoogle(credential, note); });
            return;
          }
          acceptAccount(body);
        }).catch(function (err) {
          fail(note, "V-AUTH", String(err && err.message || err), function () { verifyGoogle(credential, note); });
        });
      }).catch(function (err) {
        fail(note, "V-AUTH", "tokeninfo " + String(err && err.message || err), function () { verifyGoogle(credential, note); });
      });
  }

  function postAuth(path, payload) {
    return fetch(authBase() + "/auth/nonce", { method: "GET", credentials: "include" }).then(function (res) {
      return res.json().catch(function () { return {}; });
    }).then(function (issued) {
      var next = {};
      Object.keys(payload || {}).forEach(function (key) { next[key] = payload[key]; });
      next.nonce = issued && issued.nonce ? issued.nonce : "";
      var human = sessionStorage.getItem("valhalla-human-proof") || "";
      if (human) next.human = human;
      return fetch(authBase() + path, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + (sessionStorage.getItem("valhalla-auth-token") || "")
        },
        body: JSON.stringify(next)
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false }; }).then(function (body) {
          body.status = res.status;
          return body;
        });
      });
    });
  }

  function mountAccount() {
    var google = document.getElementById("googleBtn");
    var note = document.getElementById("accountNote");
    var entryEmail = sessionStorage.getItem("valhalla-entry-email");
    if (entryEmail) {
      var loginEmail = document.getElementById("magicEmail");
      var createEmail = document.getElementById("createEmail");
      if (loginEmail && !loginEmail.value) loginEmail.value = entryEmail;
      if (createEmail && !createEmail.value) createEmail.value = entryEmail;
      sessionStorage.removeItem("valhalla-entry-email");
    }
    var box = document.getElementById("termsOk");
    var saved = readAccount();
    if (box && saved && saved.termsAccepted) box.checked = true;
    var memory = readRemember();
    var welcome = document.getElementById("welcomeBack");
    if (memory && welcome) {
      welcome.hidden = false;
      var hello = document.getElementById("welcomeName");
      if (hello) hello.textContent = "Welcome back, " + String(memory.mask || "").split("@")[0];
      var cont = document.getElementById("welcomeContinue");
      if (cont && !cont.dataset.bound) {
        cont.dataset.bound = "1";
        cont.textContent = memory.method === "google" ? "Continue with Google" : "Send my code";
        cont.addEventListener("click", function () {
          if (memory.method === "google") {
            var button = document.querySelector("#googleSlot [role='button']");
            if (button) button.click();
            else fail(note, "V-AUTH", "google button missing", function () { location.reload(); });
          } else {
            var form = document.getElementById("emailForm");
            if (form) form.requestSubmit();
          }
        });
      }
    }
    var forget = document.getElementById("forgetDevice");
    if (forget && !forget.dataset.bound) {
      forget.dataset.bound = "1";
      forget.addEventListener("click", function (event) {
        event.preventDefault();
        forgetDevice();
      });
    }
    if (!keyReady(cfg.GOOGLE_CLIENT_ID)) {
      google.onclick = function () {
        if (!termsOk()) return;
        fail(note, "V-AUTH", "google client id missing", function () { location.reload(); });
      };
    } else if (!google.dataset.gis) {
      google.dataset.gis = "1";
      google.hidden = true;
      var script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.onload = function () {
        window.google.accounts.id.initialize({
          client_id: cfg.GOOGLE_CLIENT_ID,
          ux_mode: "popup",
          auto_select: false,
          cancel_on_tap_outside: true,
          use_fedcm_for_prompt: false,
          context: "signin",
          callback: function (resp) {
            if (window.google.accounts.id.cancel) window.google.accounts.id.cancel();
            if (!termsOk()) return;
            verifyGoogle(resp && resp.credential, note);
          }
        });
        window.google.accounts.id.renderButton(document.getElementById("googleSlot"), {
          theme: "filled_black",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
          width: 360
        });
      };
      script.onerror = function () {
        fail(note, "V-AUTH", "google identity script failed to load", function () { location.reload(); });
      };
      document.head.appendChild(script);
    }
    var showCreate = document.getElementById("showCreate");
    var showLogin = document.getElementById("showLogin");
    if (showCreate && !showCreate.dataset.bound) {
      showCreate.dataset.bound = "1";
      showCreate.addEventListener("click", function () {
        document.getElementById("createForm").hidden = false;
        document.getElementById("emailForm").hidden = true;
      });
    }
    if (showLogin && !showLogin.dataset.bound) {
      showLogin.dataset.bound = "1";
      showLogin.addEventListener("click", function () {
        document.getElementById("createForm").hidden = true;
        document.getElementById("emailForm").hidden = false;
      });
    }
    var createForm = document.getElementById("createForm");
    if (createForm && !createForm.dataset.bound) {
      createForm.dataset.bound = "1";
      createForm.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!termsOk()) return;
        var typedEmail = document.getElementById("createEmail").value.trim().toLowerCase();
        var account = readAccount() || {};
        account.walletPref = document.getElementById("createWallet").value;
        account.method = "email";
        account.termsAccepted = true;
        account.plan = "free";
        delete account.name;
        delete account.email;
        delete account.picture;
        writeAccount(account);
        if (!authBase()) {
          fail(note, "V-MAIL", "email code service unavailable", function () { createForm.requestSubmit(); });
          return;
        }
        postAuth("/auth/email/start", { email: typedEmail, alwaysAsk: alwaysAsk() }).then(function (body) {
          if (!body.ok) {
            var friendly = authNote(body.error);
            if (friendly) note.textContent = friendly;
            else fail(note, "V-MAIL", "create code " + (body.error || ""), function () { createForm.requestSubmit(); });
          }
          else showCode(body.hint, "wallet", body.pending);
        }).catch(function (err) {
          fail(note, "V-MAIL", "create code request failed: " + String(err && err.message || err), function () { createForm.requestSubmit(); });
        });
      });
    }
    var paperBtn = document.getElementById("openPaper");
    if (paperBtn && !paperBtn.dataset.bound) {
      paperBtn.dataset.bound = "1";
      paperBtn.addEventListener("click", function () {
        window.location.assign("/os/");
      });
    }
    var form = document.getElementById("emailForm");
    if (form && !form.dataset.bound) {
      form.dataset.bound = "1";
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!termsOk()) return;
        var email = document.getElementById("magicEmail").value.trim().toLowerCase();
        if (!authBase()) {
          fail(note, "V-MAIL", "email code service unavailable", function () { form.requestSubmit(); });
          return;
        }
        note.textContent = "Sending your code.";
        postAuth("/auth/email/start", { email: email, alwaysAsk: alwaysAsk() }).then(function (body) {
          if (!body.ok) {
            var friendly = authNote(body.error);
            if (friendly) note.textContent = friendly;
            else fail(note, "V-MAIL", "login code " + (body.error || ""), function () { form.requestSubmit(); });
            return;
          }
          var prior = readAccount() || {};
          prior.method = "email";
          prior.termsAccepted = true;
          delete prior.email;
          delete prior.name;
          delete prior.picture;
          writeAccount(prior);
          note.textContent = "The code was sent. It expires in 10 minutes.";
          showCode(body.hint, "wallet", body.pending);
        }).catch(function () {
          fail(note, "V-MAIL", "email start request failed", function () { form.requestSubmit(); });
        });
      });
    }
    var codeForm = document.getElementById("codeForm");
    if (codeForm && !codeForm.dataset.bound) {
      codeForm.dataset.bound = "1";
      codeForm.addEventListener("submit", function (event) {
        event.preventDefault();
        var codeError = document.getElementById("emailCodeError");
        var codeInput = document.getElementById("emailCodeInput");
        var pending = sessionStorage.getItem("valhalla-pending") || "";
        postAuth("/auth/email/verify", { pending: pending, code: codeInput ? codeInput.value.trim() : "" }).then(function (body) {
          if (!body.ok) {
            if (codeError) codeError.textContent = authNote(body.error);
            if (codeInput) codeInput.focus();
            return;
          }
          sessionStorage.setItem("valhalla-code-ok", "1");
          sessionStorage.removeItem("valhalla-pending");
          acceptAccount(body);
        }).catch(function () {
          if (codeError) fail(codeError, "V-MAIL", "email verify request failed", function () { codeForm.requestSubmit(); });
          if (codeInput) codeInput.focus();
        });
      });
    }
  }

  function mountWallet() {
    var host = document.getElementById("loginButtons");
    if (window.ValhallaSite) window.ValhallaSite.mountButtons(host);
    var account = readAccount() || {};
    var skip = document.getElementById("skipWallet");
    if (skip && !skip.dataset.bound) {
      skip.dataset.bound = "1";
      skip.addEventListener("click", function () { openDesk(); });
    }
    var onFile = document.getElementById("useOnFile");
    var note = document.getElementById("walletNote");
    var fromDesk = document.getElementById("connectFromDesk");
    if (fromDesk && !fromDesk.dataset.bound) {
      fromDesk.dataset.bound = "1";
      fromDesk.addEventListener("click", function () {
        show("gateWallet");
        mountWallet();
      });
    }
    var pref = account.walletPref || "";
    if (pref && !sessionStorage.getItem("valhalla-wallet-tried") && window.ValhallaSite && pref !== "walletconnect" && pref !== "phantom-google") {
      sessionStorage.setItem("valhalla-wallet-tried", "1");
      if (note) note.textContent = "Opening your saved wallet for a sign-in message.";
      window.ValhallaSite.continueWith(pref).catch(function () {
        if (note) note.textContent = "We could not open that wallet. Choose another, or continue without one.";
      });
    }
    if (account.wallet && window.ValhallaConnect.isPubkey(account.wallet)) {
      onFile.hidden = false;
      onFile.textContent = "Use my wallet on file …" + account.wallet.slice(-4);
      onFile.onclick = function () {
        window.__valhallaExpected = account.wallet;
        note.textContent = "Sign the login message with the wallet that ends in " + account.wallet.slice(-4) + ". The address on file is public only.";
      };
    }
  }

  function saveSession(data) {
    data.at = Date.now();
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  function accountSession(account) {
    return {
      kind: account.method === "google" ? "google" : "account",
      hint: account.hint || ""
    };
  }

  function drawFunnel() {
    var canvas = document.getElementById("net");
    if (!canvas) return;
    var tiers = [["elite", 48, "#00ff88"], ["good", 126, "#ff9a1f"], ["watch", 198, "#7a7468"], ["paused", 78, "#ff3b4a"]];
    var w = canvas.parentElement.clientWidth || 480;
    var h = 180;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#07080c";
    ctx.fillRect(0, 0, w, h);
    tiers.forEach(function (tier, index) {
      var cx = ((index + 0.5) / tiers.length) * w;
      var cy = h * 0.48;
      ctx.fillStyle = tier[2] + "33";
      ctx.beginPath();
      ctx.arc(cx, cy, 28, 0, Math.PI * 2);
      ctx.fill();
      for (var n = 0; n < 36; n += 1) {
        var ang = n * 2.4;
        var rad = 10 + (n % 6) * 6;
        ctx.fillStyle = tier[2];
        ctx.fillRect(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, 2, 2);
      }
    });
    document.getElementById("legend").textContent = tiers.map(function (tier) { return tier[0] + " " + tier[1]; }).join("   ");
    document.getElementById("stages").innerHTML = [["Scout", 120], ["Filter", 86], ["Analyst", 54], ["Copier", 17], ["Risk", 41]].map(function (row) {
      return '<div class="stage"><b>' + row[0].toUpperCase() + "</b><div>" + row[1] + " kills</div></div>";
    }).join("");
    document.getElementById("skips").innerHTML = [["liquidity floor", 64], ["breaker pause after 3 losses", 9], ["24h volume floor", 41], ["already pumped >80%", 28], ["max positions", 6], ["no pair", 33]].map(function (row) {
      return '<div class="kill"><span>' + row[1] + "</span><span>" + row[0] + "</span></div>";
    }).join("");
  }

  function deviceKeys() {
    try { return JSON.parse(localStorage.getItem("valhalla-device-keys") || "{}"); } catch (err) { return {}; }
  }

  function rpcUrl() {
    var custom = String(deviceKeys().rpc || "");
    if (custom.indexOf("https://") === 0) return custom;
    return RPC;
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

  async function birdeyePrice(mint, key) {
    var response = await fetch("https://public-api.birdeye.so/defi/price?address=" + encodeURIComponent(mint), {
      headers: { "X-API-KEY": key, "x-chain": "solana" }
    });
    if (!response.ok) return "";
    var body = await response.json();
    var value = body && body.data && body.data.value;
    return Number.isFinite(Number(value)) ? " · $" + Number(value).toFixed(4) : "";
  }

  async function balances(address) {
    var line = document.getElementById("solLine");
    var tokens = document.getElementById("tokenLines");
    var label = document.querySelector("#desk .sub");
    if (label) label.textContent = deviceKeys().birdeye ? "YOUR BALANCE · BIRDEYE + RPC" : "YOUR BALANCE · FREE RPC";
    try {
      var lamports = await rpc("getBalance", [address]);
      var sol = Number(lamports && lamports.value) / 1e9;
      line.textContent = (Number.isFinite(sol) ? sol.toFixed(4) : "0") + " SOL";
      var owned = await rpc("getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }]);
      var rows = ((owned && owned.value) || []).slice(0, 6);
      var key = String(deviceKeys().birdeye || "");
      var html = "";
      for (var i = 0; i < rows.length; i += 1) {
        var info = rows[i].account && rows[i].account.data && rows[i].account.data.parsed && rows[i].account.data.parsed.info;
        var mint = info && info.mint ? String(info.mint) : "";
        var amount = info && info.tokenAmount && info.tokenAmount.uiAmountString ? info.tokenAmount.uiAmountString : "0";
        var price = "";
        if (key && mint) {
          try { price = await birdeyePrice(mint, key); } catch (err) { price = ""; }
        }
        html += "<div>…" + (mint ? mint.slice(-4) : "coin") + " " + amount + price + "</div>";
      }
      tokens.innerHTML = html;
    } catch (err) {
      ValhallaErrors.show(line, { code: "V-DESK", public: "Balances are temporarily unavailable. Please try again shortly.", detail: "balance lookup failed" });
    }
  }

  function openDesk() {
    var session = fresh(localStorage.getItem(SESSION_KEY), 12 * 60 * 60 * 1000);
    if (session && session.kind === "paper") {
      localStorage.removeItem(SESSION_KEY);
      session = null;
    }
    if (!session) {
      var account = readAccount();
      var verified = account && account.hint &&
        sessionStorage.getItem("valhalla-auth") === "1" &&
        sessionStorage.getItem("valhalla-code-ok") === "1";
      if (verified) {
        session = accountSession(account);
        saveSession(session);
      } else {
        var pendingCode = sessionStorage.getItem("valhalla-pending");
        if (pendingCode && sessionStorage.getItem("valhalla-code-ok") !== "1") {
          show("gateCode");
        } else if (fresh(sessionStorage.getItem(HUMAN_KEY), HUMAN_MS)) {
          show("gateAccount");
          mountAccount();
        } else {
          show("gateHuman");
          mountTurnstile();
        }
        return;
      }
    }
    if ((session.kind === "google" || session.kind === "account") && sessionStorage.getItem("valhalla-entry-desk") === "1") {
      sessionStorage.removeItem("valhalla-entry-desk");
      window.location.assign("/os/");
      return;
    }
    show("desk");
    var banner = document.getElementById("connectBanner");
    if (banner) banner.hidden = Boolean(session && session.pubkey);
    drawFunnel();
    var who = document.getElementById("footWho");
    var avatar = document.getElementById("googleAvatar");
    var paste = document.getElementById("pasteForm");
    if (session.kind === "google" || session.kind === "account") {
      who.textContent = session.hint || "Account";
      if (avatar) avatar.hidden = true;
      paste.hidden = false;
      document.getElementById("modeBadge").textContent = "READ ONLY";
    } else if (session.pubkey) {
      who.textContent = "…" + session.pubkey.slice(-4);
      if (window.ValhallaSite) {
        var chip = document.getElementById("walletChip");
        chip.hidden = false;
      }
      balances(session.pubkey);
      paintMenu(session.pubkey);
    }
    tick();
    if (!clockTimer) clockTimer = window.setInterval(tick, 1000);
    window.dispatchEvent(new Event("valhalla-desk"));
  }

  function tick() {
    var clock = document.getElementById("clock");
    if (!clock) return;
    clock.textContent = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  }

  function paintMenu(pubkey) {
    var slot = document.getElementById("walletChip");
    slot.hidden = false;
    slot.textContent = "";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = "…" + pubkey.slice(-4);
    var menu = document.createElement("div");
    menu.className = "menu";
    menu.hidden = true;
    [["Copy address", function () { if (navigator.clipboard) navigator.clipboard.writeText(pubkey); }], ["Balances", function () { balances(pubkey); }], ["Disconnect wallet", function () {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem("valhalla-watch");
      sessionStorage.removeItem("valhalla-wallet-ok");
      sessionStorage.removeItem("valhalla-proof");
      openDesk();
    }]].forEach(function (item) {
      var node = document.createElement("button");
      node.type = "button";
      node.textContent = item[0];
      node.addEventListener("click", item[1]);
      menu.appendChild(node);
    });
    button.addEventListener("click", function () { menu.hidden = !menu.hidden; });
    slot.appendChild(button);
    slot.appendChild(menu);
  }

  window.addEventListener("valhalla-keys", function () {
    var current = fresh(localStorage.getItem(SESSION_KEY), 12 * 60 * 60 * 1000);
    if (current && current.pubkey) balances(current.pubkey);
  });

  document.getElementById("pasteForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var value = document.getElementById("pasteKey").value.trim();
    if (!window.ValhallaConnect.isPubkey(value)) return;
    var session = fresh(localStorage.getItem(SESSION_KEY), 12 * 60 * 60 * 1000) || { kind: "google" };
    session.pubkey = value;
    saveSession(session);
    balances(value);
    document.getElementById("footWho").textContent = "watching …" + value.slice(-4);
  });

  window.addEventListener("valhalla-signed", function (event) {
    var packed = event.detail || {};
    if (!packed.pubkey) return;
    var expected = window.__valhallaExpected || "";
    var note = document.getElementById("walletNote");
    if (expected && packed.pubkey !== expected) {
      if (note) note.textContent = "That signature is for a different wallet. Use the address on file, ending " + expected.slice(-4) + ".";
      return;
    }
    var account = readAccount() || {};
    if (!account.termsAccepted) {
      if (note) note.textContent = "Accept the Terms of Use before you sign in.";
      show("gateAccount");
      mountAccount();
      return;
    }
    sessionStorage.setItem("valhalla-proof", JSON.stringify({
      pubkey: packed.pubkey,
      message: packed.message || "",
      signature: packed.signature || ""
    }));
    account.wallet = packed.pubkey;
    if (!account.walletPref) account.walletPref = "phantom";
    writeAccount(account);
    saveSession({ kind: "wallet", pubkey: packed.pubkey, email: account.email || "" });
    sessionStorage.setItem("valhalla-wallet-ok", "1");
    var banner = document.getElementById("connectBanner");
    if (banner) banner.hidden = true;
    var desk = document.getElementById("desk");
    if (desk && !desk.hidden) {
      balances(packed.pubkey);
      paintMenu(packed.pubkey);
      return;
    }
    openDesk();
  });

  var fromDesk = document.getElementById("connectFromDesk");
  if (fromDesk && !fromDesk.dataset.bound) {
    fromDesk.dataset.bound = "1";
    fromDesk.addEventListener("click", function () {
      show("gateWallet");
      mountWallet();
    });
  }

  function initialize() {
    var human = fresh(sessionStorage.getItem(HUMAN_KEY), HUMAN_MS);
    var account = readAccount();
    var signed = sessionStorage.getItem("valhalla-wallet-ok") === "1";
    var authed = sessionStorage.getItem("valhalla-auth") === "1" && sessionStorage.getItem("valhalla-code-ok") === "1";
    if (human && account && account.hint && authed) {
      var savedSession = fresh(localStorage.getItem(SESSION_KEY), 12 * 60 * 60 * 1000);
      if (!signed || !savedSession || savedSession.kind !== "wallet") saveSession(accountSession(account));
      openDesk();
    } else if (human && sessionStorage.getItem("valhalla-pending") && sessionStorage.getItem("valhalla-code-ok") !== "1") {
      show("gateCode");
      mountAccount();
    } else if (human) {
      show("gateAccount");
      mountAccount();
    } else {
      show("gateHuman");
      mountTurnstile();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
})();
