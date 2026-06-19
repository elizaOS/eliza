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
