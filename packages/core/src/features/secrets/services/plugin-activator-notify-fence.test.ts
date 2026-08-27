/**
 * Deterministic shutdown-fencing coverage for PluginActivatorService:
 * secret-change notifications must not be dispatched after stop() is
 * requested.
 *
 * stop() unsubscribes from secret changes *before* it awaits the in-flight
 * poll, so a secret-change handler that was suspended in its missing-secrets
 * lookup when shutdown began resumes into a service that is already
 * unsubscribed. Without the fence below, that resuming handler still falls
 * through to notifySecretChanged() and fires activated plugins' onSecretChanged
 * callbacks and secret-change listeners while the service is draining
 * (see issue #29455 gap 2; the activation-path fencing in #29071 deliberately
 * leaves this notification path untouched).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockRuntime,
	MOCK_AGENT_ID,
} from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import type { SecretChangeCallback, SecretContext } from "../types.ts";
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
		pollingIntervalMs: 1,
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

describe("PluginActivatorService notification shutdown fencing", () => {
	let activeService: PluginActivatorService | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await activeService?.stop();
		activeService = undefined;
		vi.useRealTimers();
	});

	it("does not dispatch onSecretChanged notifications after stop() is requested", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		let lookupCalls = 0;
		// One shared gate: every lookup after the activation one (the poll's
		// and the secret-change handler's) suspends on the same promise, so
		// their continuations resume in FIFO order when the gate opens.
		const gate = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		const getMissingSecrets = vi.fn((_keys: string[]) => {
			lookupCalls += 1;
			if (lookupCalls === 1) {
				return Promise.resolve([]);
			}
			return gate;
		});
		const harness = await createHarness(getMissingSecrets);
		activeService = harness.service;

		const onSecretChangedA = vi.fn(async () => undefined);
		await harness.service.registerPlugin(
			makePlugin("plugin-a", onSecretChangedA),
		);
		// Activate plugin-a through a secret change (this legitimately
		// notifies it once, before any shutdown).
		await harness.emitSecretChange();
		expect(harness.service.isActivated("plugin-a")).toBe(true);

		// plugin-b stays pending and shares the same secret key.
		await harness.service.registerPlugin(makePlugin("plugin-b"));

		// A poll suspends on plugin-b's lookup and becomes the drain target.
		await vi.advanceTimersByTimeAsync(1);
		// A secret-change handler also suspends on its lookup.
		const change = harness.emitSecretChange();
		expect(lookupCalls).toBeGreaterThanOrEqual(2);

		// stop() is requested while both the poll and the handler are
		// suspended; it unsubscribes before awaiting the drain.
		const stopping = harness.service.stop();

		releaseLookup?.([]);
		await change;
		await stopping;
		await vi.advanceTimersByTimeAsync(0);

		// The resuming handler must not notify activated plugins: the only
		// notification is the legitimate one from activation (before stop).
		expect(onSecretChangedA).toHaveBeenCalledTimes(1);
	});

	it("still notifies activated plugins when stop() was never requested", async () => {
		const harness = await createHarness(async () => []);
		activeService = harness.service;

		const onSecretChangedA = vi.fn(async () => undefined);
		await harness.service.registerPlugin(
			makePlugin("plugin-a", onSecretChangedA),
		);
		// Activate plugin-a (first notification).
		await harness.emitSecretChange();
		expect(harness.service.isActivated("plugin-a")).toBe(true);

		// A later secret change for the same key notifies the activated
		// plugin again — the fence must only suppress notifications once
		// stop() has actually unsubscribed.
		await harness.emitSecretChange();
		expect(onSecretChangedA).toHaveBeenCalledTimes(2);
	});
});
