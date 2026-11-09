(function () {
  var sentPageView = false;
  var sessionStarted = false;
  var allowedEvents = {
    page_view: true,
    paper_start: true,
    paper_pause: true,
    paper_stop: true,
    chat_send: true,
    settings_open: true,
    upgrade_open: true,
    load_under_1s: true,
    load_1_3s: true,
    load_3_5s: true,
    load_over_5s: true
  };

  async function track(eventName) {
    var consent = window.ValhallaConsent;
    var cfg = window.VALHALLA_SITE || {};
    var base = String(cfg.AUTH_URL || "").replace(/\/$/, "");
    var token = sessionStorage.getItem("valhalla-auth-token") || "";
    if (!allowedEvents[eventName] || !base || !token || !consent || !consent.allows("analytics")) return;
    try {
      await fetch(base + "/auth/engagement", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token
        },
        body: JSON.stringify({ event: eventName, analyticsConsent: true })
      });
    } catch (error) {
      console.debug("valhalla", "V-ANALYTICS", String(error && error.message || error));
    }
  }

  function recordDeskView() {
    if (sentPageView) return;
    sentPageView = true;
    track("page_view");
    if (!sessionStarted) {
      sessionStarted = true;
      var nav = window.performance && performance.getEntriesByType
        ? performance.getEntriesByType("navigation")[0]
        : null;
      if (nav && Number.isFinite(nav.duration)) {
        var bucket = nav.duration < 1000 ? "load_under_1s"
          : nav.duration < 3000 ? "load_1_3s"
            : nav.duration < 5000 ? "load_3_5s" : "load_over_5s";
        track(bucket);
      }
    }
  }

  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest
      ? event.target.closest("#botStart, #botPause, #botStop, #gear, #upgradeBtn")
      : null;
    if (!target) return;
    var names = {
      botStart: "paper_start",
      botPause: "paper_pause",
      botStop: "paper_stop",
      gear: "settings_open",
      upgradeBtn: "upgrade_open"
    };
    track(names[target.id]);
  });
  document.getElementById("chatForm").addEventListener("submit", function () { track("chat_send"); });
  window.addEventListener("valhalla-desk", recordDeskView);
  window.ValhallaAnalytics = { track: track };
})();
