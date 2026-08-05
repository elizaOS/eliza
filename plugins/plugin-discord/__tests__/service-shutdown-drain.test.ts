/**
 * Covers `DiscordService#stop` wiring to the shutdown-drain registry: an
 * in-flight turn tracked via `trackInFlightTurn`/`trackStatusReaction` is
 * awaited before `stop()` completes, a shutdown with nothing tracked returns
 * promptly, and a turn that outlives `DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS` is
 * abandoned with a loud structured-logger warning rather than hanging
 * `stop()` forever. Uses a real `DiscordService` (no Discord API token
 * configured, so the account pool stays empty and no gateway connection
 * opens) with fake discord.js/runtime boundaries, matching the pattern in
 * service-account-pool.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordService } from "../service.ts";
import { DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS } from "../shutdown-drain.ts";
import type { StatusReactionController } from "../status-reactions.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000002";

function makeRuntime() {
	return {
		agentId: AGENT_ID,
		character: { name: "Eliza", settings: {} },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: vi.fn(() => undefined),
	};
}

function makeService(runtime: ReturnType<typeof makeRuntime>) {
	return new DiscordService(
		runtime as unknown as ConstructorParameters<typeof DiscordService>[0],
	);
}

function makeController(): StatusReactionController & {
	abandon: ReturnType<typeof vi.fn>;
} {
	let resolveFinished: () => void = () => {};
	const whenFinished = new Promise<void>((resolve) => {
		resolveFinished = resolve;
	});
	return {
		setQueued: vi.fn(),
		setThinking: vi.fn(),
		setDone: vi.fn(() => resolveFinished()),
		setError: vi.fn(() => resolveFinished()),
		abandon: vi.fn(() => resolveFinished()),
		whenFinished,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("DiscordService#stop shutdown drain", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns promptly when no turn is in flight", async () => {
		const runtime = makeRuntime();
		const service = makeService(runtime);

		const start = Date.now();
		await service.stop();
		const elapsedMs = Date.now() - start;

		expect(elapsedMs).toBeLessThan(DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS / 10);
		expect(runtime.logger.warn).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("Shutdown drain timeout"),
		);
	});

	it("drains an in-flight turn before completing, without abandoning its reaction", async () => {
		const runtime = makeRuntime();
		const service = makeService(runtime);
		const controller = makeController();

		service.trackInFlightTurn("msg-inflight", delay(5));
		service.trackStatusReaction("msg-inflight", controller);

		await service.stop();

		expect(controller.abandon).not.toHaveBeenCalled();
		expect(runtime.logger.warn).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("Shutdown drain timeout"),
		);
	});

	it("abandons a turn that outlives the drain timeout and logs loudly instead of hanging", async () => {
		const runtime = makeRuntime();
		const service = makeService(runtime);
		const controller = makeController();
		// Never resolves: only DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS elapsing can
		// end the wait.
		service.trackInFlightTurn("msg-hung", new Promise<void>(() => undefined));
		service.trackStatusReaction("msg-hung", controller);

		vi.useFakeTimers();
		const stopPromise = service.stop();
		await vi.advanceTimersByTimeAsync(DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS);
		await stopPromise;

		expect(controller.abandon).toHaveBeenCalledTimes(1);
		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				src: "plugin:discord",
				abandonedMessageIds: ["msg-hung"],
				drainTimeoutMs: DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS,
			}),
			expect.stringContaining("[DiscordService]"),
		);
	});
});
