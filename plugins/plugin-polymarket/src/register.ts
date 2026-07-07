/**
 * `appRegister` side-effect entry: registers the Polymarket view as an
 * app-shell page for native platforms that disable `DynamicViewLoader`.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native.
registerAppShellPage({
  id: "polymarket",
  pluginId: "@elizaos/plugin-polymarket",
  label: "Predictions",
  icon: "BarChart2",
  path: "/polymarket",
  tabAffinity: "inventory",
  group: "wallet",
  order: 70,
  loader: () =>
    import("./polymarket-view-bundle.ts").then((m) => ({
      default: m.PolymarketView,
    })),
});
