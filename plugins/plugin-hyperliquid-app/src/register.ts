import "./hyperliquid-app";
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
// the render path on native. See packages/app/src/mobile-plugin-views.ts.
registerAppShellPage({
  id: "hyperliquid",
  pluginId: "@elizaos/plugin-hyperliquid-app",
  label: "Hyperliquid",
  icon: "TrendingUp",
  path: "/hyperliquid",
  loader: () =>
    import("./HyperliquidAppView.tsx").then((m) => ({
      default: m.HyperliquidAppView,
    })),
});
