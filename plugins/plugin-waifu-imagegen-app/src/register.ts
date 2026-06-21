// Side-effect entry: importing this registers the waifu image-gen overlay app
// with `@elizaos/app-core` (see `./imagegen-app`). The app's view loader is then
// discoverable + launchable by the shell. This is what the app's side-effect
// loader imports.
//
// No terminal-view registration: ImageGenAppView is an interactive
// prompt/upload/preview form that POSTs to the waifu invoke endpoint and renders
// a generated <img>. It has no read-only snapshot data model to project into a
// terminal/TUI surface, so (unlike hyperliquid) this plugin declares no `tui`
// view and registers none. If a terminal projection is added later, build a
// spatial snapshot component and register it DOM-guarded here.
import "./imagegen-app";
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native. See packages/app/src/mobile-plugin-views.ts.
registerAppShellPage({
  id: "waifu-imagegen",
  pluginId: "@elizaos/plugin-waifu-imagegen-app",
  label: "Image Generation",
  icon: "Image",
  path: "/waifu-imagegen",
  loader: () =>
    import("./ui.ts").then((m) => ({
      default: m.ImageGenAppView,
    })),
});
