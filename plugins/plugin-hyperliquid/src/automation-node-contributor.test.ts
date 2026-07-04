/**
 * Unit tests for the Hyperliquid automation-node contributor: registration,
 * and the enabled/disabled state of its nodes based on loaded plugins/actions.
 * Runtime context is a plain in-memory stub — no live model or agent.
 */
import {
	type AutomationNodeContributorContext,
	clearAutomationNodeContributorsForTests,
	listAutomationNodeContributors,
} from "@elizaos/app-core/api/automation-node-contributors";
import { afterEach, describe, expect, it } from "vitest";
import { registerHyperliquidAutomationNodeContributor } from "./automation-node-contributor";

function context(
	runtime: Partial<{
		actions: Array<{ name: string; similes?: string[] }>;
		plugins: Array<{ name: string }>;
	}>,
): AutomationNodeContributorContext {
	return {
		runtime: { actions: [], plugins: [], ...runtime } as never,
		config: {} as never,
		agentName: "Eliza",
		adminEntityId: "admin" as never,
	};
}

const HYPERLIQUID_NODE_IDS = [
	"crypto:hyperliquid.action",
	"trigger:order.event",
];

describe("plugin-hyperliquid automation node contributor", () => {
	afterEach(() => {
		clearAutomationNodeContributorsForTests();
	});

	it("registers exactly one hyperliquid contributor", () => {
		registerHyperliquidAutomationNodeContributor();
		expect(listAutomationNodeContributors()).toHaveLength(1);
	});

	it("emits disabled hyperliquid nodes when no capability is loaded", async () => {
		registerHyperliquidAutomationNodeContributor();
		const [contributor] = listAutomationNodeContributors();
		const nodes = await contributor(context({}));

		expect(nodes.map((node) => node.id)).toEqual(HYPERLIQUID_NODE_IDS);
		expect(nodes.every((node) => node.availability === "disabled")).toBe(true);
		expect(
			nodes.find((node) => node.id === "crypto:hyperliquid.action")
				?.disabledReason,
		).toBe("Load the Hyperliquid runtime plugin.");
		expect(
			nodes.find((node) => node.id === "trigger:order.event")?.disabledReason,
		).toBe("Load an order-event-capable runtime plugin.");
	});

	it("enables both nodes when the hyperliquid plugin is loaded", async () => {
		registerHyperliquidAutomationNodeContributor();
		const [contributor] = listAutomationNodeContributors();
		const nodes = await contributor(
			context({ plugins: [{ name: "@elizaos/plugin-hyperliquid" }] }),
		);

		expect(nodes.map((node) => node.id)).toEqual(HYPERLIQUID_NODE_IDS);
		expect(nodes.every((node) => node.availability === "enabled")).toBe(true);
	});

	it("enables both nodes when a HYPERLIQUID_ACTION runtime action is present", async () => {
		registerHyperliquidAutomationNodeContributor();
		const [contributor] = listAutomationNodeContributors();
		const nodes = await contributor(
			context({ actions: [{ name: "HYPERLIQUID_ACTION" }] }),
		);

		expect(nodes.every((node) => node.availability === "enabled")).toBe(true);
	});
});
