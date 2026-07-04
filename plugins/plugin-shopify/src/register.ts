/**
 * Registers the Shopify dashboard page with the app-shell page registry, and in
 * a DOM-less terminal host also registers the terminal view (lazy + guarded so
 * the terminal engine stays out of browser/mobile bundles).
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

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

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native.
registerAppShellPage({
  id: "shopify",
  pluginId: "@elizaos/plugin-shopify",
  label: "Shopify",
  icon: "ShoppingBag",
  path: "/shopify",
  loader: () =>
    import("./shopify-view-bundle.ts").then((m) => ({
      default: m.ShopifyView,
    })),
});
