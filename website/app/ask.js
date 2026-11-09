(function () {
  var DAY = "valhalla-ask-day";

  function cfg() {
    return window.VALHALLA_SITE || {};
  }

  function clock() {
    return window.performance && window.performance.now ? window.performance.now() : Date.now();
  }

  function recordPerformance(started, status, provider, model, outputChars) {
    if (!window.ValhallaPerformance) return;
    window.ValhallaPerformance.record({
      provider: provider,
      model: model,
      durationMs: clock() - started,
      firstTextMs: null,
      outputChars: outputChars,
      status: status
    });
  }

  function secretLike(text) {
    var words = String(text || "").trim().split(/\s+/);
    if (words.length >= 12 && words.length <= 24 && words.every(function (word) { return /^[a-z]+$/.test(word); })) return true;
    if (/[1-9A-HJ-NP-Za-km-z]{64,}/.test(text || "")) return true;
    return false;
  }

  function count() {
    try { return JSON.parse(localStorage.getItem(DAY) || "{}"); } catch (err) { return {}; }
  }

  function bubble() {
    if (document.getElementById("askValhalla")) return;
    var root = document.createElement("div");
    root.id = "askValhalla";
    root.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:40;font:13px/1.4 ui-monospace,monospace";
    root.innerHTML = '<button type="button" id="askOpen" aria-label="Ask Thales" style="width:48px;height:48px;border-radius:24px;border:1px solid #ffb347;background:#1a140c;color:#ffb347">V</button>'
      + '<form id="askPanel" hidden style="width:min(320px,calc(100vw - 32px));background:#0a0a0e;border:1px solid #ffb347;padding:10px;margin-bottom:8px">'
      + '<p id="askOut">Ask Thales a question. Not financial advice.</p>'
      + '<textarea id="askText" rows="3" maxlength="500" aria-label="Ask Thales" placeholder="Ask Thales" style="width:100%"></textarea>'
      + '<button type="submit">Send</button>'
      + '<p>Not financial advice.</p></form>';
    document.body.appendChild(root);
    document.getElementById("askOpen").onclick = function () {
      var panel = document.getElementById("askPanel");
      panel.hidden = !panel.hidden;
    };
    document.getElementById("askPanel").onsubmit = function (event) {
      event.preventDefault();
      send();
    };
  }

  async function send() {
    var out = document.getElementById("askOut");
    var text = document.getElementById("askText").value;
    if (secretLike(text)) {
      out.textContent = "Do not paste a seed phrase or a private key. That text was not sent.";
      document.getElementById("askText").value = "";
      return;
    }
    var base = String(cfg().CHAT_URL || cfg().AGENT_API_URL || "");
    if (!base) {
      out.textContent = "Chat service is not configured. Please try again later. (V-CHAT-CONFIG)";
      return;
    }
    var today = new Date().toISOString().slice(0, 10);
    var used = count();
    if (used.day !== today) used = { day: today, n: 0 };
    if (used.n >= 20) {
      out.textContent = "The free limit for today is full. Try later.";
      return;
    }
    var token = "";
    var input = document.querySelector("[name='cf-turnstile-response']");
    if (used.n === 0) token = input ? input.value : "";
    if (used.n === 0 && !token) {
      out.textContent = "A human check is required for the first message.";
      return;
    }
    var started = clock();
    var provider = "unknown";
    var model = "unreported";
    try {
      var response = await fetch(base.replace(/\/$/, "") + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 500), token: token, stream: false })
      });
      provider = response.headers.get("x-valhalla-provider") || provider;
      model = response.headers.get("x-valhalla-model") || model;
      if (!response.ok) {
        var error = await response.json().catch(function () { return {}; });
        recordPerformance(started, "error", provider, model, 0);
        out.textContent = String(error.error || "Chat service returned HTTP " + response.status + " (V-CHAT-HTTP).");
        return;
      }
      var body = await response.json();
      var reply = String(body.reply || "");
      if (!reply.trim()) {
        recordPerformance(started, "error", provider, model, 0);
        out.textContent = "The assistant returned an empty response. (V-CHAT-EMPTY)";
        return;
      }
      recordPerformance(started, "ok", provider, model, reply.length);
      used.n += 1;
      localStorage.setItem(DAY, JSON.stringify(used));
      out.textContent = reply + " Not financial advice.";
    } catch (err) {
      recordPerformance(started, "error", provider, model, 0);
      out.textContent = "The assistant could not be reached. Please try again. (V-CHAT-NETWORK)";
    }
  }

  function boot() {
    if (!window.ValhallaConsent || !window.ValhallaConsent.allows("functional")) return;
    bubble();
  }

  window.addEventListener("valhalla-consent", boot);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
