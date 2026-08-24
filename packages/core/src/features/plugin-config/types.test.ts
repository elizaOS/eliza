/**
 * Unit coverage for the plugin-config runtime contract in ./types. The
 * PLUGIN_CONFIG_CLIENT_SERVICE lookup key and the PLUGIN_ACTIVATED_EVENT name
 * are cross-package wire contracts — cloud / app-core adapters register under
 * these exact strings while the feature's actions resolve and emit through
 * the same constants. Drives the real sibling actions against a recording
 * stub runtime to prove both constants are load-bearing at the
 * service-resolution and event-emission boundaries. Deterministic — no live
 * model or database.
 */
import { describe, expect, test } from "vitest";
import { ChannelType } from "../../types/primitives";
import { activatePluginIfReadyAction } from "./actions/activate-plugin-if-ready";
import { probePluginConfigRequirementsAction } from "./actions/probe-plugin-config-requirements";
import { PLUGIN_ACTIVATED_EVENT, PLUGIN_CONFIG_CLIENT_SERVICE } from "./types";

function createRecordingRuntime(client: unknown) {
	const requestedServiceNames: string[] = [];
	const emittedEvents: Array<{ eventName: string; payload: unknown }> = [];
	return {
		requestedServiceNames,
		emittedEvents,
		runtime: {
			agentId: "agent-1",
			getService: (name: string) => {
				requestedServiceNames.push(name);
				return name === PLUGIN_CONFIG_CLIENT_SERVICE ? client : null;
			},
			emitEvent: async (eventName: string, payload: unknown) => {
				emittedEvents.push({ eventName, payload });
			},
		},
	};
}

function createMessage() {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "", channelType: ChannelType.DM },
	};
}

function createClient(overrides: Record<string, unknown> = {}) {
	return {
		getRequirements: async () => null,
		createConfigRequest: async () => null,
		getStatus: async () => null,
		activate: async () => false,
		...overrides,
	};
}

describe("plugin-config runtime contract constants", () => {
	test("PLUGIN_CONFIG_CLIENT_SERVICE keeps its documented stable value", () => {
		expect(PLUGIN_CONFIG_CLIENT_SERVICE).toBe("PluginConfigClient");
	});

	test("PLUGIN_ACTIVATED_EVENT keeps its documented stable value", () => {
		expect(PLUGIN_ACTIVATED_EVENT).toBe("PluginActivated");
	});
});

describe("service-resolution boundary", () => {
	test("probe action resolves its client exclusively under the exported service key", async () => {
		const { runtime, requestedServiceNames } = createRecordingRuntime(
			createClient({
				getRequirements: async () => ({
					pluginName: "anthropic",
					required: ["ANTHROPIC_API_KEY"],
					optional: [],
					present: ["ANTHROPIC_API_KEY"],
					missing: [],
				}),
			}),
		);

		const result = await probePluginConfigRequirementsAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		expect(requestedServiceNames.length).toBeGreaterThan(0);
		for (const name of requestedServiceNames) {
			expect(name).toBe(PLUGIN_CONFIG_CLIENT_SERVICE);
		}
	});

	test("actions fail cleanly when nothing is registered under the service key", async () => {
		const { runtime } = createRecordingRuntime(null);

		const probed = await probePluginConfigRequirementsAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);
		const activated = await activatePluginIfReadyAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(probed.success).toBe(false);
		expect(probed.text).toBe("PluginConfigClient not available");
		expect(activated.success).toBe(false);
		expect(activated.text).toBe("PluginConfigClient not available");
	});

	test("validate rejects when the service key resolves to nothing", async () => {
		const absent = createRecordingRuntime(null);
		const present = createRecordingRuntime(createClient());

		const rejected = await probePluginConfigRequirementsAction.validate(
			absent.runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
		);
		const accepted = await probePluginConfigRequirementsAction.validate(
			present.runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
		);

		expect(rejected).toBe(false);
		expect(accepted).toBe(true);
	});
});

describe("activation event boundary", () => {
	test("successful activation emits exactly the exported event name with the documented payload", async () => {
		const { runtime, emittedEvents } = createRecordingRuntime(
			createClient({
				getStatus: async () => ({
					pluginName: "anthropic",
					ready: true,
					missing: [],
				}),
				activate: async () => true,
			}),
		);

		const result = await activatePluginIfReadyAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		expect(emittedEvents.length).toBe(1);
		expect(emittedEvents[0].eventName).toBe(PLUGIN_ACTIVATED_EVENT);
		const payload = emittedEvents[0].payload as {
			pluginName: string;
			at: number;
		};
		expect(payload.pluginName).toBe("anthropic");
		expect(typeof payload.at).toBe("number");
	});

	test("a not-ready plugin is refused without emitting the activation event", async () => {
		const { runtime, emittedEvents } = createRecordingRuntime(
			createClient({
				getStatus: async () => ({
					pluginName: "anthropic",
					ready: false,
					missing: ["ANTHROPIC_API_KEY"],
				}),
				activate: async () => true,
			}),
		);

		const result = await activatePluginIfReadyAction.handler(
			runtime as never,
			createMessage() as never,
			undefined,
			{ parameters: { pluginName: "anthropic" } } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		const data = result.data as { reason: string; missing: string[] };
		expect(data.reason).toBe("not_ready");
		expect(data.missing).toEqual(["ANTHROPIC_API_KEY"]);
		expect(emittedEvents.length).toBe(0);
	});
});
