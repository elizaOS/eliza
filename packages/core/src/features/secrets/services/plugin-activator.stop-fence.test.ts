/**
 * Lifecycle fencing for secret-driven plugin activation across shutdown.
 *
 * `stop()` clears its maps only after awaiting in-flight work, so a secret
 * lookup suspended when shutdown begins can resume, still satisfy the
 * post-await identity guard, and start a brand-new activation after stop was
 * requested. These cases pin every entrypoint that can resume across that
 * boundary — the poll, the secret-change handler, and registration — while
 * proving an already-started activation is still drained rather than orphaned.
 *
 * Real activator service; only the SecretsService collaborator is scripted so
 * a lookup can be suspended at an exact point relative to `stop()`.
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

const PLUGIN: PluginWithSecrets = {
	name: "stop-fence-plugin",
	description: "Exercises activation fencing across stop().",
	requiredSecrets: {
		TOKEN: { description: "Test token", type: "token", required: true },
	},
};

const SECRETLESS_PLUGIN: PluginWithSecrets = {
	name: "stop-fence-secretless",
	description: "Activates immediately when no secrets are required.",
};

const GLOBAL_CONTEXT: SecretContext = {
	level: "global",
	agentId: MOCK_AGENT_ID,
	requesterId: MOCK_AGENT_ID,
};

interface Harness {
	service: PluginActivatorService;
	emitSecretChange: () => Promise<void>;
	setRequirements: (ready: boolean) => void;
	holdRequirements: () => { release: () => void; entered: Promise<void> };
}

async function createHarness(
	getMissingSecrets: (keys: string[]) => Promise<string[]>,
): Promise<Harness> {
	let secretChangeCallback: SecretChangeCallback | undefined;
	let requirementsReady = false;
	let requirementsGate: Promise<void> | undefined;
	let markEntered: (() => void) | undefined;

	const secretsService = {
		checkPluginRequirements: vi.fn(async () => {
			if (requirementsGate) {
				markEntered?.();
				await requirementsGate;
			}
			return {
				ready: requirementsReady,
				missingRequired: requirementsReady ? [] : ["TOKEN"],
				missingOptional: [],
				invalid: [],
			};
		}),
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
		setRequirements: (ready: boolean) => {
			requirementsReady = ready;
		},
		holdRequirements: () => {
			let release: (() => void) | undefined;
			requirementsGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				markEntered = resolve;
			});
			return {
				entered,
				release: () => {
					requirementsGate = undefined;
					release?.();
				},
			};
		},
	};
}

describe("PluginActivatorService stop fencing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("refuses activation when a poll lookup resolves after stop was requested", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const suspended = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		let markEntered: (() => void) | undefined;
		const lookupEntered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		let firstLookup = true;
		const harness = await createHarness(async () => {
			if (firstLookup) {
				firstLookup = false;
				markEntered?.();
				return suspended;
			}
			return [];
		});
		const activation = vi.fn(async () => undefined);

		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);

		await vi.advanceTimersByTimeAsync(2);
		await lookupEntered;

		const stopping = harness.service.stop();
		releaseLookup?.([]);
		await stopping;
		await vi.advanceTimersByTimeAsync(5);

		expect(activation).not.toHaveBeenCalled();
	});

	it("refuses activation when a secret-change lookup resolves after stop was requested", async () => {
		let releaseLookup: ((missing: string[]) => void) | undefined;
		const suspended = new Promise<string[]>((resolve) => {
			releaseLookup = resolve;
		});
		let markEntered: (() => void) | undefined;
		const lookupEntered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		let firstLookup = true;
		const harness = await createHarness(async () => {
			if (firstLookup) {
				firstLookup = false;
				markEntered?.();
				return suspended;
			}
			return [];
		});
		const activation = vi.fn(async () => undefined);

		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);

		const change = harness.emitSecretChange();
		await lookupEntered;

		const stopping = harness.service.stop();
		releaseLookup?.([]);
		await change;
		await stopping;
		await vi.advanceTimersByTimeAsync(5);

		expect(activation).not.toHaveBeenCalled();
	});

	it("refuses a secretless registration made after stop completed", async () => {
		const harness = await createHarness(async () => []);
		const activation = vi.fn(async () => undefined);

		await harness.service.stop();

		expect(
			await harness.service.registerPlugin(SECRETLESS_PLUGIN, activation),
		).toBe(false);
		await vi.advanceTimersByTimeAsync(5);

		expect(activation).not.toHaveBeenCalled();
		expect(harness.service.isActivated(SECRETLESS_PLUGIN.name)).toBe(false);
	});

	it("refuses a registration suspended in checkPluginRequirements that resolves after stop", async () => {
		const harness = await createHarness(async () => []);
		const activation = vi.fn(async () => undefined);
		harness.setRequirements(true);
		const gate = harness.holdRequirements();

		const registration = harness.service.registerPlugin(PLUGIN, activation);
		await gate.entered;

		const stopping = harness.service.stop();
		gate.release();

		expect(await registration).toBe(false);
		await stopping;
		await vi.advanceTimersByTimeAsync(5);

		expect(activation).not.toHaveBeenCalled();
		expect(harness.service.getPendingPlugins()).toEqual([]);
		expect(harness.service.getRegisteredPluginIds()).toEqual([]);
	});

	it("still drains an activation that started before stop without re-entering it", async () => {
		let releaseActivation: (() => void) | undefined;
		const activationGate = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		let markStarted: (() => void) | undefined;
		const activationStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const activation = vi.fn(async () => {
			markStarted?.();
			await activationGate;
		});
		const harness = await createHarness(async () => []);

		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);
		const change = harness.emitSecretChange();
		await activationStarted;

		let settled = false;
		const stopping = harness.service.stop().then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(5);
		expect(settled).toBe(false);

		releaseActivation?.();
		await change;
		await stopping;

		expect(settled).toBe(true);
		expect(activation).toHaveBeenCalledTimes(1);
	});
});
