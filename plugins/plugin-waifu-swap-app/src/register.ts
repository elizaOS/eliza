// Side-effect entry: importing this registers the swap overlay app with the
// app-core overlay registry (see swap-app.ts's registerOverlayApp call), so the
// view is discoverable/launchable as soon as the plugin module graph loads.
import "./swap-app";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native. See packages/app/src/mobile-plugin-views.ts. The
// in-process page renders the unified spatial SwapView (GUI/XR surface).
registerAppShellPage({
  id: "waifu-swap",
  pluginId: "@elizaos/plugin-waifu-swap-app",
  label: "Swap",
  icon: "ArrowLeftRight",
  path: "/waifu-swap",
  loader: () =>
    import("./swap-app-view-bundle.ts").then((m) => ({
      default: m.SwapView,
    })),
});

// In a terminal host (the Node agent, no DOM), register the swap view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerSwapTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
