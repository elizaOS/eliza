/**
 * Side-effect module: wires the Hyperliquid view into hosts that bypass the
 * network-served `DynamicViewLoader` — the terminal engine (Node agent, no
 * DOM) and native iOS/Android (which disable `DynamicViewLoader` and need the
 * already-bundled component registered as an app-shell page).
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// In a terminal host (the Node agent, no DOM), register the Hyperliquid view so
// it renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerHyperliquidTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native.
registerAppShellPage({
  id: "hyperliquid",
  pluginId: "@elizaos/plugin-hyperliquid",
  label: "Hyperliquid",
  icon: "TrendingUp",
  path: "/hyperliquid",
  loader: () =>
    import("./hyperliquid-app-view-bundle.ts").then((m) => ({
      default: m.HyperliquidView,
    })),
});
