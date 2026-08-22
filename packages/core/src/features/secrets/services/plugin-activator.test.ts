/**
 * Deterministic unit coverage for secret-driven plugin activation concurrency.
 * A mocked SecretsService controls readiness while the real activator service
 * runs its interval and secret-change entrypoints under fake timers.
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
	name: "concurrency-test-plugin",
	description: "Exercises secret-driven activation concurrency.",
	requiredSecrets: {
		TOKEN: {
			description: "Test token",
			type: "token",
			required: true,
		},
	},
};

const GLOBAL_CONTEXT: SecretContext = {
	level: "global",
	agentId: MOCK_AGENT_ID,
	requesterId: MOCK_AGENT_ID,
};

interface ActivatorHarness {
	emitSecretChange: () => Promise<void>;
	reportError: ReturnType<typeof vi.fn>;
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
	const reportError = vi.fn();
	const runtime = createMockRuntime({
		getService: (() =>
			secretsService as SecretsService) as IAgentRuntime["getService"],
		reportError,
	});
	const service = await PluginActivatorService.start(runtime, {
		enableAutoActivation: true,
		pollingIntervalMs: 1,
	});

	return {
		service,
		reportError,
		emitSecretChange: async () => {
			if (!secretChangeCallback) {
				throw new Error("Secret-change callback was not registered");
			}
			await secretChangeCallback("TOKEN", "ready", GLOBAL_CONTEXT);
		},
	};
}

describe("PluginActivatorService concurrency", () => {
	let activeService: PluginActivatorService | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await activeService?.stop();
		activeService = undefined;
		vi.useRealTimers();
	});

	it("joins polling and secret-change activation into one attempt", async () => {
		let releaseActivation: (() => void) | undefined;
		const activationGate = new Promise<void>((resolve) => {
			releaseActivation = resolve;
		});
		let markActivationStarted: (() => void) | undefined;
		const activationStarted = new Promise<void>((resolve) => {
			markActivationStarted = resolve;
		});
		const activation = vi.fn(async () => {
			markActivationStarted?.();
			await activationGate;
		});
		const harness = await createHarness(async () => []);
		activeService = harness.service;

		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);
		const secretChange = harness.emitSecretChange();
		await activationStarted;

		await vi.advanceTimersByTimeAsync(5);
		expect(activation).toHaveBeenCalledTimes(1);

		releaseActivation?.();
		await secretChange;
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.service.isActivated(PLUGIN.name)).toBe(true);
	});

	it("serializes polls, reports failures, and retries activation", async () => {
		let releaseFirstPoll: ((missing: string[]) => void) | undefined;
		const firstPoll = new Promise<string[]>((resolve) => {
			releaseFirstPoll = resolve;
		});
		const pollFailure = new Error("secret lookup unavailable");
		let pollCalls = 0;
		let concurrentPolls = 0;
		let maxConcurrentPolls = 0;
		const getMissingSecrets = vi.fn(async () => {
			pollCalls += 1;
			concurrentPolls += 1;
			maxConcurrentPolls = Math.max(maxConcurrentPolls, concurrentPolls);
			try {
				if (pollCalls === 1) return await firstPoll;
				if (pollCalls === 2) throw pollFailure;
				return [];
			} finally {
				concurrentPolls -= 1;
			}
		});
		const activationFailure = new Error("plugin startup failed");
		const activation = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(activationFailure)
			.mockResolvedValueOnce(undefined);
		const harness = await createHarness(getMissingSecrets);
		activeService = harness.service;
		expect(await harness.service.registerPlugin(PLUGIN, activation)).toBe(
			false,
		);

		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(5);
		expect(getMissingSecrets).toHaveBeenCalledTimes(1);
		expect(maxConcurrentPolls).toBe(1);

		releaseFirstPoll?.(["TOKEN"]);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(harness.reportError).toHaveBeenCalledWith(
			"PluginActivator.poll",
			pollFailure,
		);

		await vi.advanceTimersByTimeAsync(1);
		expect(activation).toHaveBeenCalledTimes(1);
		expect(harness.service.isPending(PLUGIN.name)).toBe(true);

		await vi.advanceTimersByTimeAsync(1);
		expect(activation).toHaveBeenCalledTimes(2);
		expect(harness.service.isActivated(PLUGIN.name)).toBe(true);
		expect(maxConcurrentPolls).toBe(1);
	});
});
