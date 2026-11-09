(function () {
  var cfg = window.VALHALLA_SITE || {};
  var price = cfg.PRO_PRICE || "$9.99/mo launch price";
  var trialDays = Number(cfg.TRIAL_DAYS) > 0 ? Number(cfg.TRIAL_DAYS) : 15;
  document.querySelectorAll("[data-price]").forEach(function (node) {
    node.textContent = price;
  });
  document.querySelectorAll("[data-trial]").forEach(function (node) {
    node.textContent = trialDays + " day free Pro trial";
  });
  fetch("version.json", { cache: "no-store" }).then(function (res) {
    return res.ok ? res.json() : null;
  }).then(function (doc) {
    if (!doc || !doc.version) return;
    var key = "valhalla-site-version";
    var seen = localStorage.getItem(key);
    if (seen && seen !== doc.version) {
      localStorage.setItem(key, doc.version);
      location.reload();
      return;
    }
    localStorage.setItem(key, doc.version);
  }).catch(function () {});

  function checkoutHref(base, source) {
    var trimmed = (base || "").trim();
    if (!trimmed) return "";
    var url = new URL(trimmed);
    var email = (cfg.SIGNED_IN_EMAIL || "").trim();
    if (email.indexOf("@") > 0 && email.indexOf(" ") < 0) url.searchParams.set("checkout[email]", email);
    url.searchParams.set("checkout[custom][source]", source || "website");
    return url.toString();
  }

  function proClick(event) {
    var url = checkoutHref(cfg.LEMONSQUEEZY_CHECKOUT_URL, "website");
    var note = document.getElementById("pro-note");
    if (!url) {
      event.preventDefault();
      if (note) note.textContent = "Checkout is not connected yet. Pro is " + price + ". This is not a promise of profit.";
      return;
    }
    event.currentTarget.setAttribute("href", url);
  }
  document.querySelectorAll("[data-chrome]").forEach(function (link) {
    var store = (cfg.CHROME_WEB_STORE_URL || "").trim();
    link.textContent = "Add to Chrome";
    link.href = store || "extension/";
  });
  document.querySelectorAll("[data-pro]").forEach(function (link) {
    link.href = "app/";
    link.classList.remove("lemonsqueezy-button");
  });
  function showPlan(name, raw) {
    var href = checkoutHref(raw, "website");
    document.querySelectorAll("[data-plan='" + name + "']").forEach(function (link) {
      if (!href) {
        link.hidden = true;
        return;
      }
      link.hidden = false;
      link.href = href;
      link.classList.add("lemonsqueezy-button");
    });
    return Boolean(href);
  }
  var yearOn = showPlan("yearly", cfg.LEMONSQUEEZY_YEARLY_URL);
  var lifeOn = showPlan("lifetime", cfg.LEMONSQUEEZY_LIFETIME_URL);
  var soon = document.getElementById("plan-soon");
  if (soon) soon.hidden = yearOn && lifeOn;
  if (window.createLemonSqueezy) window.createLemonSqueezy();

  document.querySelectorAll("[data-tour]").forEach(function (button) {
    button.addEventListener("click", function () {
      var name = button.getAttribute("data-tour");
      ["phone-frame", "desk-frame"].forEach(function (id) {
        var frame = document.getElementById(id);
        if (frame && frame.contentWindow) frame.contentWindow.postMessage(name, "*");
      });
      document.querySelectorAll("[data-tour]").forEach(function (other) {
        other.setAttribute("aria-selected", other === button ? "true" : "false");
      });
    });
  });

  var film = document.getElementById("demo-film");
  var play = document.getElementById("play-film");
  if (film && play) {
    play.addEventListener("click", function () {
      film.muted = false;
      film.controls = true;
      film.play();
      play.hidden = true;
    });
  }

  var form = document.getElementById("brain-form");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var email = document.getElementById("brain-email").value.trim();
      var note = document.getElementById("brain-note").value.trim();
      var status = document.getElementById("form-status");
      if (cfg.formspree) {
        status.textContent = "Sending.";
        fetch(cfg.formspree, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ email: email, note: note, topic: "Valhalla Brain API" })
        }).then(function (response) {
          status.textContent = response.ok ? "Sent. No wallet key was asked." : "The form did not accept that. Use the email link.";
        }).catch(function () {
          status.textContent = "The form could not be reached. Use the email link.";
        });
        return;
      }
      window.location.href = "mailto:hello@valhalla-app.xyz?subject=" + encodeURIComponent("Valhalla Brain API") + "&body=" + encodeURIComponent("Email: " + email + "\n\n" + note);
      status.textContent = "Your mail app should open. Do not send a key or a seed phrase.";
    });
  }

  var faq = [];
  fetch("faq.json").then(function (response) { return response.json(); }).then(function (rows) { faq = rows; }).catch(function () { faq = []; });

  function answerFor(text) {
    var lower = text.toLowerCase();
    var hit = faq.find(function (row) {
      return row.keys.some(function (key) { return lower.indexOf(key) !== -1; });
    });
    return (hit && hit.a) || "I can answer questions about the app, Pro, downloads, and safety. I do not give financial advice.";
  }

  var ask = document.getElementById("talk-ask");
  var talkText = document.getElementById("talk-text");
  var talkOut = document.getElementById("talk-out");
  function speak(text) {
    if (talkOut) talkOut.textContent = text;
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
  function askText(text) {
    speak(answerFor(text));
  }
  if (ask) {
    ask.addEventListener("click", function () {
      var Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Speech) {
        if (talkText) talkText.focus();
        if (talkOut) talkOut.textContent = "This browser has no speech recognition. Type the question instead.";
        return;
      }
      var rec = new Speech();
      rec.lang = "en-US";
      rec.onresult = function (event) {
        var said = event.results[0][0].transcript;
        if (talkText) talkText.value = said;
        askText(said);
      };
      rec.onerror = function () {
        if (talkOut) talkOut.textContent = "The microphone did not answer. Type the question instead.";
      };
      rec.start();
    });
  }
  var talkForm = document.getElementById("talk-form");
  if (talkForm) {
    talkForm.addEventListener("submit", function (event) {
      event.preventDefault();
      askText(talkText.value.trim());
    });
  }
})();
