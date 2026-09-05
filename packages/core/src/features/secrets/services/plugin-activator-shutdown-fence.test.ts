/**
 * Deterministic shutdown-fencing coverage for PluginActivatorService.
 *
 * Once stop() is requested, suspended polling and secret-change handlers must
 * not start additional secret lookups, activate more plugins, or dispatch
 * secret-change callbacks into the draining service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockRuntime,
	MOCK_AGENT_ID,
} from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import type {
	PluginRequirementStatus,
	SecretChangeCallback,
	SecretContext,
} from "../types.ts";
import {
	PluginActivatorService,
	type PluginWithSecrets,
} from "./plugin-activator.ts";
import type { SecretsService } from "./secrets.ts";

const GLOBAL_CONTEXT: SecretContext = {
	level: "global",
	agentId: MOCK_AGENT_ID,
	requesterId: MOCK_AGENT_ID,
};

function makePlugin(
	name: string,
	onSecretChanged?: PluginWithSecrets["onSecretChanged"],
): PluginWithSecrets {
	const plugin: PluginWithSecrets = {
		name,
		description: `Exercises shutdown fencing for ${name}.`,
		requiredSecrets: {
			TOKEN: {
				description: "Test token",
				type: "token",
				required: true,
			},
		},
	};
	if (onSecretChanged) {
		plugin.onSecretChanged = onSecretChanged;
	}
	return plugin;
}

interface ActivatorHarness {
	emitSecretChange: () => Promise<void>;
	service: PluginActivatorService;
}

async function createHarness(
	getMissingSecrets: (keys: string[]) => Promise<string[]>,
	pollingIntervalMs = 1,
): Promise<ActivatorHarness> {
	let secretChangeCallback: SecretChangeCallback | undefined;
	const secretsService = {
		checkPluginRequirements: vi.fn(async () => ({
			ready: false,
			missingRequired: ["TOKEN"],
			missingOptional: [],
			invalid: [],
		})),
		getMissingSecrets: vi.fn(getMissingSecrets),
		onAnySecretChanged: vi.fn((callback: SecretChangeCallback) => {
			secretChangeCallback = callback;
			return () => undefined;
		}),
	} satisfies Pick<
		SecretsService,
		"checkPluginRequirements" | "getMissingSecrets" | "onAnySecretChanged"
	>;
	const runtime = createMockRuntime({
		getService: (() =>
			secretsService as SecretsService) as IAgentRuntime["getService"],
		reportError: vi.fn(),
	});
	const service = await PluginActivatorService.start(runtime, {
		enableAutoActivation: true,
		pollingIntervalMs,
	});

	return {
		service,
		emitSecretChange: async () => {
			if (!secretChangeCallback) {
				throw new Error("Secret-change callback was not registered");
			}
			await secretChangeCallback("TOKEN", "ready", GLOBAL_CONTEXT);
		},
	};
}

describe("PluginActivatorService shutdown fencing", () => {
	let activeService: PluginActivatorService | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await activeService?.stop();
		activeService = undefined;
		vi.useRealTimers();
	});

	it("does not start another poll lookup after stop() is requested", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const gate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		let lookupCalls = 0;
		const harness = await createHarness(async () => {
			lookupCalls += 1;
			return gate;
		});
		activeService = harness.service;

		await harness.service.registerPlugin(makePlugin("plugin-a"));
		await harness.service.registerPlugin(makePlugin("plugin-b"));

		// The first poll suspends on plugin-a. If the loop merely continues after
		// shutdown, it will incorrectly start a second lookup for plugin-b.
		await vi.advanceTimersByTimeAsync(1);
		expect(lookupCalls).toBe(1);

		const stopping = harness.service.stop();
		releaseLookup?.(["TOKEN"]);
		await stopping;
		await vi.advanceTimersByTimeAsync(0);

		expect(lookupCalls).toBe(1);
	});

	it("fences a resumed poll before its pending activation callback", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const gate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		let lookupCalls = 0;
		const harness = await createHarness(async () => {
			lookupCalls += 1;
			return gate;
		});
		activeService = harness.service;

		await harness.service.registerPlugin(makePlugin("plugin-a"));
		const internals = harness.service as unknown as {
			activatePlugin: (
				pluginId: string,
				plugin: PluginWithSecrets,
				callback?: () => Promise<void>,
			) => Promise<boolean>;
		};
		const activatePlugin = vi
			.spyOn(internals, "activatePlugin")
			.mockResolvedValue(true);

		// Keep the poll suspended past shutdown intent. Stubbing the downstream
		// activation fence makes this assertion specifically pin the post-await
		// poll fence instead of letting a later defensive guard mask its removal.
		await vi.advanceTimersByTimeAsync(1);
		expect(lookupCalls).toBe(1);
		const stopping = harness.service.stop();

		releaseLookup?.([]);
		await stopping;

		expect(activatePlugin).not.toHaveBeenCalled();
	});

	it("does not start another secret-change lookup after stop() is requested", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const gate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		let lookupCalls = 0;
		const harness = await createHarness(async () => {
			lookupCalls += 1;
			return gate;
		}, 1000);
		activeService = harness.service;

		await harness.service.registerPlugin(makePlugin("plugin-a"));
		await harness.service.registerPlugin(makePlugin("plugin-b"));

		// The change handler suspends on plugin-a's lookup. stop() tracks that
		// handler and must remain pending until it drains instead of clearing state
		// early and accidentally making the loop stop for the wrong reason.
		const change = harness.emitSecretChange();
		expect(lookupCalls).toBe(1);
		let stopResolved = false;
		const stopping = harness.service.stop().then(() => {
			stopResolved = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(stopResolved).toBe(false);
		expect(harness.service.getRegisteredPluginIds()).toContain("plugin-a");

		releaseLookup?.(["TOKEN"]);
		await change;
		await stopping;

		expect(lookupCalls).toBe(1);
		expect(stopResolved).toBe(true);
	});

	it("does not dispatch secret-change notifications after stop() is requested", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		let lookupCalls = 0;
		const gate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		const harness = await createHarness(async () => {
			lookupCalls += 1;
			if (lookupCalls === 1) {
				return [];
			}
			return gate;
		});
		activeService = harness.service;

		const onSecretChangedA = vi.fn(async () => undefined);
		await harness.service.registerPlugin(
			makePlugin("plugin-a", onSecretChangedA),
		);
		await harness.emitSecretChange();
		expect(harness.service.isActivated("plugin-a")).toBe(true);
		expect(onSecretChangedA).toHaveBeenCalledTimes(1);

		// Register listeners only after the legitimate activation notification so
		// any invocation below is unambiguously post-stop behavior.
		const keyedListener = vi.fn(async () => undefined);
		const globalListener = vi.fn(async () => undefined);
		harness.service.onSecretChangedKey("TOKEN", keyedListener);
		harness.service.onAnySecretChanged(globalListener);

		await harness.service.registerPlugin(makePlugin("plugin-b"));

		// A poll and a change handler both suspend on the same lookup gate.
		await vi.advanceTimersByTimeAsync(1);
		const change = harness.emitSecretChange();
		const stopping = harness.service.stop();

		releaseLookup?.([]);
		await change;
		await stopping;
		await vi.advanceTimersByTimeAsync(0);

		// Only the legitimate pre-shutdown plugin notification remains, and no
		// registered listener is invoked while the service drains.
		expect(onSecretChangedA).toHaveBeenCalledTimes(1);
		expect(keyedListener).not.toHaveBeenCalled();
		expect(globalListener).not.toHaveBeenCalled();
	});

	it("drains an in-flight notification without starting later callbacks", async () => {
		const harness = await createHarness(async () => [], 1000);
		activeService = harness.service;

		let markSecondAStarted: (() => void) | undefined;
		const secondAStarted = new Promise<void>((resolve) => {
			markSecondAStarted = resolve;
		});
		let releaseSecondA: (() => void) | undefined;
		const secondAGate = new Promise<void>((resolve) => {
			releaseSecondA = resolve;
		});
		let aCalls = 0;
		const onSecretChangedA = vi.fn(async () => {
			aCalls += 1;
			if (aCalls === 2) {
				markSecondAStarted?.();
				await secondAGate;
			}
		});
		const onSecretChangedB = vi.fn(async () => undefined);

		await harness.service.registerPlugin(
			makePlugin("plugin-a", onSecretChangedA),
		);
		await harness.service.registerPlugin(
			makePlugin("plugin-b", onSecretChangedB),
		);

		// Activate both plugins and deliver one legitimate notification to each.
		await harness.emitSecretChange();
		expect(onSecretChangedA).toHaveBeenCalledTimes(1);
		expect(onSecretChangedB).toHaveBeenCalledTimes(1);

		const keyedListener = vi.fn(async () => undefined);
		const globalListener = vi.fn(async () => undefined);
		harness.service.onSecretChangedKey("TOKEN", keyedListener);
		harness.service.onAnySecretChanged(globalListener);

		// The second notification reaches A and suspends inside its callback before
		// B or either listener is visited. Shutdown must drain A, but it must not
		// return early or start any later callback after shutdown intent is visible.
		const change = harness.emitSecretChange();
		await secondAStarted;

		let stopResolved = false;
		const stopping = harness.service.stop().then(() => {
			stopResolved = true;
		});
		// Flush the fake-timer/microtask queue far enough that a stop() without the
		// activeSecretChanges drain would already have resolved.
		await vi.advanceTimersByTimeAsync(0);
		expect(stopResolved).toBe(false);

		releaseSecondA?.();
		await change;
		await stopping;

		expect(stopResolved).toBe(true);
		expect(onSecretChangedA).toHaveBeenCalledTimes(2);
		expect(onSecretChangedB).toHaveBeenCalledTimes(1);
		expect(keyedListener).not.toHaveBeenCalled();
		expect(globalListener).not.toHaveBeenCalled();
	});

	it("does not start later keyed listeners while a change drains", async () => {
		const harness = await createHarness(async () => [], 1000);
		activeService = harness.service;

		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstKeyed = vi.fn(async () => {
			markFirstStarted?.();
			await firstGate;
		});
		const laterKeyed = vi.fn(async () => undefined);
		const globalListener = vi.fn(async () => undefined);
		harness.service.onSecretChangedKey("TOKEN", firstKeyed);
		harness.service.onSecretChangedKey("TOKEN", laterKeyed);
		harness.service.onAnySecretChanged(globalListener);

		// With no registered plugins, this path reaches the keyed-listener loop
		// directly. Shutdown lands while its first callback is suspended, making
		// the per-iteration keyed fence the only guard before the later callback.
		const change = harness.emitSecretChange();
		await firstStarted;
		const stopping = harness.service.stop();

		releaseFirst?.();
		await change;
		await stopping;

		expect(firstKeyed).toHaveBeenCalledTimes(1);
		expect(laterKeyed).not.toHaveBeenCalled();
		expect(globalListener).not.toHaveBeenCalled();
	});

	it("does not start later global listeners while a change drains", async () => {
		const harness = await createHarness(async () => [], 1000);
		activeService = harness.service;

		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstGlobal = vi.fn(async () => {
			markFirstStarted?.();
			await firstGate;
		});
		const laterGlobal = vi.fn(async () => undefined);
		harness.service.onAnySecretChanged(firstGlobal);
		harness.service.onAnySecretChanged(laterGlobal);

		// No plugin or keyed listener runs before this loop, so the second global
		// callback is protected specifically by the global per-iteration fence.
		const change = harness.emitSecretChange();
		await firstStarted;
		const stopping = harness.service.stop();

		releaseFirst?.();
		await change;
		await stopping;

		expect(firstGlobal).toHaveBeenCalledTimes(1);
		expect(laterGlobal).not.toHaveBeenCalled();
	});

	it("rejects registration after stop without doing secret or activation work", async () => {
		const harness = await createHarness(async () => [], 1000);
		activeService = harness.service;

		const requirementCheck = vi.spyOn(
			harness.service,
			"checkPluginRequirements",
		);
		const activationCallback = vi.fn(async () => undefined);
		const onSecretsReady = vi.fn(async () => undefined);
		const plugin = makePlugin("plugin-after-stop");
		plugin.onSecretsReady = onSecretsReady;

		await harness.service.stop();
		activeService = undefined;

		const activated = await harness.service.registerPlugin(
			plugin,
			activationCallback,
		);

		expect(activated).toBe(false);
		expect(requirementCheck).not.toHaveBeenCalled();
		expect(activationCallback).not.toHaveBeenCalled();
		expect(onSecretsReady).not.toHaveBeenCalled();
		expect(
			harness.service.getRegisteredPlugin("plugin-after-stop"),
		).toBeUndefined();
		expect(harness.service.isPending("plugin-after-stop")).toBe(false);
		expect(harness.service.isActivated("plugin-after-stop")).toBe(false);
	});

	it("does not let an in-flight registration repopulate state after stop", async () => {
		const harness = await createHarness(async () => [], 1000);
		activeService = harness.service;

		let releaseRequirements:
			| ((status: PluginRequirementStatus) => void)
			| undefined;
		const requirementsGate = new Promise<PluginRequirementStatus>((resolve) => {
			releaseRequirements = resolve;
		});
		const requirementCheck = vi
			.spyOn(harness.service, "checkPluginRequirements")
			.mockReturnValue(requirementsGate);
		const activationCallback = vi.fn(async () => undefined);
		const onSecretsReady = vi.fn(async () => undefined);
		const plugin = makePlugin("plugin-racing-stop");
		plugin.onSecretsReady = onSecretsReady;

		const registration = harness.service.registerPlugin(
			plugin,
			activationCallback,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(requirementCheck).toHaveBeenCalledTimes(1);
		expect(harness.service.getRegisteredPlugin("plugin-racing-stop")).toBe(
			plugin,
		);

		await harness.service.stop();
		activeService = undefined;
		releaseRequirements?.({
			pluginId: "plugin-racing-stop",
			ready: true,
			missingRequired: [],
			missingOptional: [],
			invalid: [],
			message: "All secrets available",
		});

		expect(await registration).toBe(false);
		expect(activationCallback).not.toHaveBeenCalled();
		expect(onSecretsReady).not.toHaveBeenCalled();
		expect(
			harness.service.getRegisteredPlugin("plugin-racing-stop"),
		).toBeUndefined();
		expect(harness.service.isPending("plugin-racing-stop")).toBe(false);
		expect(harness.service.isActivated("plugin-racing-stop")).toBe(false);
	});

	it("still notifies activated plugins while the service is running", async () => {
		const harness = await createHarness(async () => []);
		activeService = harness.service;

		const onSecretChangedA = vi.fn(async () => undefined);
		await harness.service.registerPlugin(
			makePlugin("plugin-a", onSecretChangedA),
		);
		await harness.emitSecretChange();
		expect(harness.service.isActivated("plugin-a")).toBe(true);

		await harness.emitSecretChange();
		expect(onSecretChangedA).toHaveBeenCalledTimes(2);
	});
});
