// Self-register Shopify overlay app at import time.
import "./shopify-app";

// In a terminal host (the Node agent, no DOM), register the Shopify view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerShopifyTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
