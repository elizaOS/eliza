/**
 * Side-effect module: wires the Hyperliquid view into native iOS/Android hosts,
 * which disable the network-served `DynamicViewLoader` and need the
 * already-bundled component registered as an app-shell page.
 */
import { registerAppShellPage } from "@elizaos/ui/app-shell-registry";

// iOS/Android disable DynamicViewLoader, so register this view's already-bundled
// component as an in-process app-shell page. Web/desktop dedupe it against the
// agent-served bundle entry (network wins -> DynamicViewLoader), so it only adds
// the render path on native.
registerAppShellPage({
	id: "hyperliquid",
	pluginId: "@elizaos/plugin-hyperliquid",
	label: "Perps",
	icon: "TrendingUp",
	path: "/hyperliquid",
	tabAffinity: "inventory",
	group: "wallet",
	order: 60,
	loader: () =>
		import("./hyperliquid-app-view-bundle.ts").then((m) => ({
			default: m.HyperliquidView,
		})),
});
