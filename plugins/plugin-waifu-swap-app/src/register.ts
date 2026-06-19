// Side-effect entry: importing this registers the swap overlay app with the
// app-core overlay registry (see swap-app.ts's registerOverlayApp call), so the
// view is discoverable/launchable as soon as the plugin module graph loads.
//
// No terminal-view registration. Unlike plugin-hyperliquid-app's read-only
// dashboard (a presentational snapshot that renders cleanly to terminal lines
// via @elizaos/ui/spatial), SwapAppView is an interactive form — token
// selectors, a numeric amount field, slippage/fee controls, and a swap CTA —
// built on @elizaos/app-core (React-DOM) and @elizaos/ui/agent-surface. It has
// no read-only snapshot shape to render, so a TUI view is intentionally
// omitted rather than fabricated.
import "./swap-app";
