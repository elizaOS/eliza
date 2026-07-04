/**
 * Registers this plugin's automation-catalog node contributor with app-core,
 * so the Hyperliquid action and order-event trigger show up as nodes in the
 * automation builder whenever the Hyperliquid plugin is loaded.
 */
import {
	type AutomationNodeContributorContext,
	buildRuntimeCapabilityNodes,
	type RuntimeCapabilityNodeSpec,
	registerAutomationNodeContributor,
} from "@elizaos/app-core/api/automation-node-contributors";
import type { AutomationNodeDescriptor } from "@elizaos/shared";

/**
 * Automation catalog nodes owned by the Hyperliquid plugin: the Hyperliquid
 * trading action and the venue order-lifecycle event trigger. They live here
 * (not hardcoded in app-core) so a Hyperliquid action rename or plugin name
 * change updates the node alongside the code that gates it.
 */
const HYPERLIQUID_AUTOMATION_NODE_SPECS: RuntimeCapabilityNodeSpec[] = [
	{
		id: "crypto:hyperliquid.action",
		label: "Hyperliquid action",
		description:
			"Hyperliquid automation entry point backed by a loaded Hyperliquid runtime plugin.",
		class: "action",
		backingCapability: "HYPERLIQUID_ACTION",
		actionNames: [
			"HYPERLIQUID_ACTION",
			"HYPERLIQUID_ORDER",
			"HYPERLIQUID_TRADE",
		],
		pluginNames: [
			"hyperliquid",
			"plugin-hyperliquid",
			"@elizaos/plugin-hyperliquid",
		],
		ownerScoped: true,
		enabledWithoutRuntimeCapability: false,
		disabledReason: "Load the Hyperliquid runtime plugin.",
	},
	{
		id: "trigger:order.event",
		label: "Order event",
		description:
			"React to order lifecycle events emitted by a loaded trading venue plugin.",
		class: "trigger",
		backingCapability: "ORDER_EVENT",
		actionNames: [
			"ORDER_EVENT",
			"ORDER_FILLED",
			"ORDER_UPDATED",
			"HYPERLIQUID_ACTION",
		],
		pluginNames: [
			"hyperliquid",
			"plugin-hyperliquid",
			"@elizaos/plugin-hyperliquid",
		],
		ownerScoped: false,
		enabledWithoutRuntimeCapability: false,
		disabledReason: "Load an order-event-capable runtime plugin.",
	},
];

export function buildHyperliquidAutomationNodes({
	runtime,
}: AutomationNodeContributorContext): AutomationNodeDescriptor[] {
	return buildRuntimeCapabilityNodes(
		HYPERLIQUID_AUTOMATION_NODE_SPECS,
		runtime,
	);
}

export function registerHyperliquidAutomationNodeContributor(): void {
	registerAutomationNodeContributor(
		"hyperliquid",
		buildHyperliquidAutomationNodes,
	);
}
