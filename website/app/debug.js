(function () {
  function showLock() {
    var lock = document.getElementById("debugLock");
    if (lock) lock.textContent = "This view is not available.";
  }

  async function boot() {
    var panel = document.getElementById("debugPanel");
    if (!panel || location.hash !== "#debug") return;
    panel.hidden = false;
    var base = String((window.VALHALLA_SITE || {}).REPAIR_URL || "").replace(/\/$/, "");
    var proof = null;
    try { proof = JSON.parse(sessionStorage.getItem("valhalla-proof") || "null"); } catch (err) { proof = null; }
    if (!base || !proof || !proof.pubkey) {
      showLock();
      return;
    }
    try {
      var response = await fetch(base + "/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(proof)
      });
      if (!response.ok) {
        showLock();
        return;
      }
      var report = await response.json();
      var log = document.getElementById("debugLog");
      var lock = document.getElementById("debugLock");
      if (lock) lock.textContent = report.text || "Hourly report";
      if (log) {
        log.textContent = ["Fixes"].concat(report.fixes || []).concat(["Alerts"]).concat(report.alerts || []).concat(["Proposals"]).concat((report.proposals || []).map(function (item) {
          return item.text + " (" + item.status + ")";
        })).join("\n");
      }
    } catch (err) {
      console.debug("valhalla", "V-DEBUG", String(err && err.message || err));
      showLock();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
