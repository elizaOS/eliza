// Side-effect entry: importing this registers the waifu image-gen overlay app
// with `@elizaos/app-core` (see `./imagegen-app`). The app's view loader is then
// discoverable + launchable by the shell. This is what the app's side-effect
// loader imports.
import "./imagegen-app";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native. See packages/app/src/mobile-plugin-views.ts. The
// in-process page renders the unified spatial ImageGenView (GUI/XR surface).
registerAppShellPage({
  id: "waifu-imagegen",
  pluginId: "@elizaos/plugin-waifu-imagegen-app",
  label: "Image Generation",
  icon: "Image",
  path: "/waifu-imagegen",
  loader: () =>
    import("./ui.ts").then((m) => ({
      default: m.ImageGenView,
    })),
});

// In a terminal host (the Node agent, no DOM), register the image-gen view so
// it renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerImageGenTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}
