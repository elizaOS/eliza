import "./polymarket-app";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// In a terminal host (the Node agent, no DOM), register the Polymarket view so
// it renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerPolymarketTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native. See packages/app/src/mobile-plugin-views.ts.
registerAppShellPage({
  id: "polymarket",
  pluginId: "@elizaos/plugin-polymarket-app",
  label: "Polymarket",
  icon: "BarChart2",
  path: "/polymarket",
  loader: () =>
    import("./polymarket-view-bundle.ts").then((m) => ({
      default: m.PolymarketAppView,
    })),
});
