// Minimal handshake to wake the MV3 service worker and ensure the WS connect loop runs.
// Fires at document_start on all pages, and on focus/visibility/page-show.
(function () {
  const MSG = { type: "computeruse_content_handshake" };
  function sendHandshake() {
    try {
      chrome.runtime.sendMessage(MSG, () => {
        // ignore response
      });
    } catch (_) {
      // Ignore if not allowed on special pages
    }
  }

  // Initial handshake as early as possible
  sendHandshake();

  // Wake-ups on focus/visibility
  try {
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") sendHandshake();
      },
      { capture: false, passive: true }
    );
  } catch (_) {}
  try {
    window.addEventListener("focus", sendHandshake, {
      capture: true,
      passive: true,
    });
  } catch (_) {}
  try {
    window.addEventListener("pageshow", sendHandshake, {
      capture: true,
      passive: true,
    });
  } catch (_) {}
})();
