/**
 * Drives the real initial-login retry loop (`DiscordService.attemptDiscordLogin`)
 * against a deterministic fake discord.js client, plus focused checks of the
 * real backoff (`computeLoginBackoffMs`) and throttled failure heartbeat
 * (`emitLoginFailureHeartbeat`). Guards #15855 (a transient boot-time login
 * failure retries with capped-exponential backoff and eventually reaches ready
 * instead of leaving the process connected-but-deaf) and #15968 (terminal
 * authentication/configuration failures reject typed and stop retrying; at most
 * one retry timer per account with no append-only handle history; the real
 * `stop()` cancels a pending backoff and invalidates in-flight attempts so no
 * client or timer is ever created after stop). Collaborators that are not under
 * test (event wiring, onReady backfill, legacy aliasing, voice teardown) are
 * stubbed on the instance; the retry/backoff/heartbeat/stop code runs for real.
 */
import { ElizaError } from "@elizaos/core";
import { Events } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DiscordAccountClientPool,
	type DiscordAccountClientState,
} from "../account-client-pool.ts";
import { DiscordService } from "../service.ts";

type FakeClient = {
	once: (event: string, cb: (...args: unknown[]) => void) => FakeClient;
	on: () => FakeClient;
	login: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	isReady: () => boolean;
	emit: (event: string, ...args: unknown[]) => void;
	/** Settles a `{ kind: "hang" }` login with a rejection (post-stop races). */
	rejectPendingLogin: (error: unknown) => void;
};

type LoginBehavior =
	| { kind: "succeed" }
	| { kind: "reject"; error: Error }
	// Login promise stays pending until the test settles it via
	// rejectPendingLogin (or emits ClientReady), modelling an in-flight attempt.
	| { kind: "hang" };

function transientSocketError(): Error {
	return new Error("The socket connection was closed unexpectedly.");
}

function makeFakeClient(behavior: LoginBehavior): FakeClient {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	let rejectPending: ((error: unknown) => void) | undefined;
	const client: FakeClient = {
		once(event, cb) {
			handlers.set(event, cb);
			return client;
		},
		on: () => client,
		destroy: vi.fn().mockResolvedValue(undefined),
		isReady: () => true,
		emit(event, ...args) {
			handlers.get(event)?.(...args);
		},
		rejectPendingLogin(error) {
			rejectPending?.(error);
		},
		login: vi.fn().mockImplementation(() => {
			if (behavior.kind === "reject") {
				return Promise.reject(behavior.error);
			}
			if (behavior.kind === "hang") {
				return new Promise((_resolve, reject) => {
					rejectPending = reject;
				});
			}
			// discord.js emits ClientReady asynchronously once the gateway session
			// is up; mirror that so the ready handler fires after login resolves.
			queueMicrotask(() => client.emit(Events.ClientReady, client));
			return Promise.resolve("token");
		}),
	};
	return client;
}

function makeRuntime() {
	return {
		agentId: "agent-1",
		character: { name: "Eliza" },
		reportError: vi.fn(),
		logger: {
			error: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
		},
	};
}

function makeState(accountId: string): DiscordAccountClientState {
	return {
		accountId,
		account: { accountId, token: "bot-token" },
		client: null,
		settings: {},
		dynamicChannelIds: new Set(),
		clientReadyPromise: null,
		loginFailed: false,
	} as unknown as DiscordAccountClientState;
}

// The retry loop's private surface plus the collaborators the real `stop()`
// touches, exposed for direct driving in tests.
type TestService = DiscordService & {
	attemptDiscordLogin: (
		state: DiscordAccountClientState,
		token: string,
		attempt: number,
		resolve: () => void,
		reject: (error: unknown) => void,
		generation: number,
	) => void;
	computeLoginBackoffMs: (attempt: number) => number;
	emitLoginFailureHeartbeat: (
		state: DiscordAccountClientState,
		error: unknown,
		attempt: number,
		delayMs: number,
	) => void;
	timeouts: ReturnType<typeof setTimeout>[];
	accountPool: DiscordAccountClientPool;
	onReadyForAccount: ReturnType<typeof vi.fn>;
	_loginFailed: boolean;
	lifecycleGeneration: number;
};

/**
 * Fabricates a DiscordService around the real prototype: the retry loop,
 * classification, backoff, heartbeat, and `stop()` run for real; heavy gateway
 * collaborators are stubbed. `accountPool` is the real pool so `stop()`
 * exercises genuine state iteration and clearing.
 */
function makeService(
	runtime: ReturnType<typeof makeRuntime>,
	createClient: () => FakeClient,
): TestService {
	return Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		defaultAccountId: "default",
		_loginFailed: false,
		lifecycleGeneration: 0,
		timeouts: [] as ReturnType<typeof setTimeout>[],
		accountPool: new DiscordAccountClientPool(),
		voiceTargets: { unregisterAccount: vi.fn(), clear: vi.fn() },
		audioSinks: new Map(),
		createDiscordJsClient: createClient,
		// Isolate the retry loop from the heavy gateway/backfill collaborators.
		setupEventListenersForAccount: vi.fn(),
		onReadyForAccount: vi.fn().mockResolvedValue(undefined),
		syncLegacyDefaultAliases: vi.fn(),
	}) as unknown as TestService;
}

describe("DiscordService initial-login retry (#15855, #15968)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a transient login failure with backoff and eventually reaches ready", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const FAIL_TIMES = 2;

		const service = makeService(runtime, () => {
			const client = makeFakeClient(
				clients.length >= FAIL_TIMES
					? { kind: "succeed" }
					: { kind: "reject", error: transientSocketError() },
			);
			clients.push(client);
			return client;
		});

		const state = makeState("default");
		let readyResolved = false;

		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		}).then(() => {
			readyResolved = true;
		});

		// Advance past both backoff windows (1s + 2s) so all three attempts run.
		await vi.advanceTimersByTimeAsync(5_000);
		await ready;

		// login was attempted more than once (one client per attempt).
		const totalLoginCalls = clients.reduce(
			(sum, c) => sum + c.login.mock.calls.length,
			0,
		);
		expect(clients.length).toBe(FAIL_TIMES + 1);
		expect(totalLoginCalls).toBeGreaterThan(1);

		// The ready promise resolves once the network recovers.
		expect(readyResolved).toBe(true);
		expect(state.loginFailed).toBe(false);
		expect(service._loginFailed).toBe(false);

		// A Warn heartbeat named the account + failure while it was failing.
		const warnCalls = runtime.logger.warn.mock.calls;
		expect(warnCalls.length).toBeGreaterThanOrEqual(1);
		const heartbeat = warnCalls.find((call) =>
			String(call[1] ?? call[0]).includes("connected-but-deaf"),
		);
		expect(heartbeat).toBeDefined();
		expect(String(heartbeat?.[1])).toContain("default");
		// The first retry waits the backoff base (1s) and names the attempt.
		expect(heartbeat?.[0]).toMatchObject({
			accountId: "default",
			attempt: 1,
			retryInMs: 1_000,
			error: "The socket connection was closed unexpectedly.",
		});

		// Once connected, the loop stops: discord.js owns reconnection from here,
		// so no further warn heartbeat fires however long we wait, and no retry
		// timer stays armed on the account.
		const warnCountAtReady = runtime.logger.warn.mock.calls.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(runtime.logger.warn.mock.calls.length).toBe(warnCountAtReady);
		expect(state.loginRetryTimer).toBeUndefined();
		expect(state.cancelLoginRetry).toBeUndefined();

		// Timer hygiene (#15968): retry handles are tracked per account, never
		// appended to the service-wide timeouts array as fired-handle history.
		expect(service.timeouts.length).toBe(0);
	});

	it("keeps exactly one tracked retry handle across a long transient outage", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const FAIL_TIMES = 8;

		const service = makeService(runtime, () => {
			const client = makeFakeClient(
				clients.length >= FAIL_TIMES
					? { kind: "succeed" }
					: { kind: "reject", error: transientSocketError() },
			);
			clients.push(client);
			return client;
		});
		const state = makeState("default");

		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		});

		// Walk the outage attempt by attempt: after each failure exactly one
		// handle is armed on the state and nothing accumulates service-wide.
		for (let attempt = 0; attempt < FAIL_TIMES; attempt += 1) {
			await vi.advanceTimersByTimeAsync(0);
			expect(state.loginRetryTimer).toBeDefined();
			expect(typeof state.cancelLoginRetry).toBe("function");
			expect(service.timeouts.length).toBe(0);
			await vi.advanceTimersByTimeAsync(service.computeLoginBackoffMs(attempt));
		}
		await ready;

		expect(clients.length).toBe(FAIL_TIMES + 1);
		expect(state.loginRetryTimer).toBeUndefined();
		expect(state.cancelLoginRetry).toBeUndefined();
		expect(service.timeouts.length).toBe(0);
	});

	it("classifies an invalid token as terminal: typed rejection, owner report, no retry", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const service = makeService(runtime, () => {
			const client = makeFakeClient({
				kind: "reject",
				error: Object.assign(new Error("An invalid token was provided."), {
					code: "TokenInvalid",
				}),
			});
			clients.push(client);
			return client;
		});
		const state = makeState("default");

		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bad-token", 0, resolve, reject, 0);
		});
		const rejection = await ready.then(
			() => {
				throw new Error("ready promise must reject for a terminal failure");
			},
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(ElizaError);
		expect(rejection).toMatchObject({
			code: "DISCORD_LOGIN_TERMINAL",
			severity: "fatal",
			context: { accountId: "default", attempt: 1 },
		});
		expect((rejection as ElizaError).cause).toMatchObject({
			code: "TokenInvalid",
		});

		// The dead account is raised through the diagnostic boundary so the owner
		// sees it (RECENT_ERRORS / escalation), not just a debug log.
		expect(runtime.reportError).toHaveBeenCalledTimes(1);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"discord:login",
			rejection,
			{ accountId: "default" },
		);

		// Terminal means terminal: no timer armed, and however long we wait no
		// new client or login attempt appears.
		expect(state.loginRetryTimer).toBeUndefined();
		expect(state.cancelLoginRetry).toBeUndefined();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(clients.length).toBe(1);
		expect(clients[0]?.login).toHaveBeenCalledTimes(1);
		expect(state.loginFailed).toBe(true);
		expect(service._loginFailed).toBe(true);
		expect(state.client).toBeNull();
	});

	it("classifies a privileged-intent gateway rejection as terminal", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const service = makeService(runtime, () => {
			// @discordjs/ws surfaces close code 4014 as a plain Error with exactly
			// this message via the shard error event / login rejection.
			const client = makeFakeClient({
				kind: "reject",
				error: new Error("Used disallowed intents"),
			});
			clients.push(client);
			return client;
		});
		const state = makeState("default");

		const rejection = await new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		}).then(
			() => {
				throw new Error("ready promise must reject for a terminal failure");
			},
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(ElizaError);
		expect(rejection).toMatchObject({ code: "DISCORD_LOGIN_TERMINAL" });
		expect(runtime.reportError).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(600_000);
		expect(clients.length).toBe(1);
		expect(state.loginRetryTimer).toBeUndefined();
	});

	it("treats a terminal gateway Error event as terminal too", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const service = makeService(runtime, () => {
			const client = makeFakeClient({ kind: "hang" });
			clients.push(client);
			return client;
		});
		const state = makeState("default");

		const readyOutcome = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		}).then(
			() => {
				throw new Error("ready promise must reject for a terminal failure");
			},
			(error: unknown) => error,
		);

		// The gateway Error event (not the login rejection) carries the terminal
		// close-code failure.
		clients[0]?.emit(Events.Error, new Error("Authentication failed"));
		const rejection = await readyOutcome;

		expect(rejection).toBeInstanceOf(ElizaError);
		expect(rejection).toMatchObject({ code: "DISCORD_LOGIN_TERMINAL" });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(clients.length).toBe(1);
	});

	it("stop() during backoff cancels the pending retry and settles the ready promise", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const service = makeService(runtime, () => {
			const client = makeFakeClient({
				kind: "reject",
				error: transientSocketError(),
			});
			clients.push(client);
			return client;
		});
		const state = makeState("default");
		service.accountPool.set(state);

		const readyOutcome = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		}).then(
			() => {
				throw new Error("ready promise must not resolve after stop()");
			},
			(error: unknown) => error,
		);

		// Let the first attempt fail and arm the backoff timer.
		await vi.advanceTimersByTimeAsync(0);
		expect(state.loginRetryTimer).toBeDefined();

		await service.stop();

		// The armed timer is cleared and the ready promise settles typed.
		expect(state.loginRetryTimer).toBeUndefined();
		expect(state.cancelLoginRetry).toBeUndefined();
		const rejection = await readyOutcome;
		expect(rejection).toBeInstanceOf(ElizaError);
		expect(rejection).toMatchObject({ code: "DISCORD_LOGIN_ABORTED" });

		// No resurrection: however long we wait after stop, no new client is
		// created and no further login fires.
		await vi.advanceTimersByTimeAsync(600_000);
		expect(clients.length).toBe(1);
		expect(clients[0]?.login).toHaveBeenCalledTimes(1);
		expect(service.accountPool.list().length).toBe(0);
	});

	it("a login rejection landing after stop() cannot arm a timer or create a client", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const service = makeService(runtime, () => {
			const client = makeFakeClient({ kind: "hang" });
			clients.push(client);
			return client;
		});
		const state = makeState("default");
		service.accountPool.set(state);

		const readyOutcome = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		}).then(
			() => {
				throw new Error("ready promise must not resolve after stop()");
			},
			(error: unknown) => error,
		);

		await service.stop();

		// The in-flight login() settles only now, after teardown.
		clients[0]?.rejectPendingLogin(transientSocketError());
		const rejection = await readyOutcome;

		expect(rejection).toBeInstanceOf(ElizaError);
		expect(rejection).toMatchObject({ code: "DISCORD_LOGIN_ABORTED" });
		expect((rejection as ElizaError).cause).toMatchObject({
			message: "The socket connection was closed unexpectedly.",
		});
		expect(state.loginRetryTimer).toBeUndefined();

		await vi.advanceTimersByTimeAsync(600_000);
		expect(clients.length).toBe(1);
		expect(clients[0]?.login).toHaveBeenCalledTimes(1);
	});

	it("a ClientReady landing after stop() does not resurrect the connector", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const service = makeService(runtime, () => {
			const client = makeFakeClient({ kind: "hang" });
			clients.push(client);
			return client;
		});
		const state = makeState("default");
		service.accountPool.set(state);

		const readyOutcome = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		}).then(
			() => {
				throw new Error("ready promise must not resolve after stop()");
			},
			(error: unknown) => error,
		);

		await service.stop();
		// stop() already destroyed the pooled client.
		expect(clients[0]?.destroy).toHaveBeenCalled();

		// A late gateway ready must not run onReady side effects or resolve.
		clients[0]?.emit(Events.ClientReady, clients[0]);
		const rejection = await readyOutcome;

		expect(rejection).toBeInstanceOf(ElizaError);
		expect(rejection).toMatchObject({ code: "DISCORD_LOGIN_ABORTED" });
		expect(service.onReadyForAccount).not.toHaveBeenCalled();
		expect(state.client).toBeNull();

		await vi.advanceTimersByTimeAsync(600_000);
		expect(clients.length).toBe(1);
	});

	it("computes capped exponential backoff per attempt", () => {
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime: makeRuntime(),
		}) as unknown as DiscordService & {
			computeLoginBackoffMs: (attempt: number) => number;
		};

		// Delay doubles from the 1s base each attempt, then clamps at the 60s cap
		// so an indefinitely-down network settles into a steady retry cadence.
		expect(service.computeLoginBackoffMs(0)).toBe(1_000);
		expect(service.computeLoginBackoffMs(1)).toBe(2_000);
		expect(service.computeLoginBackoffMs(2)).toBe(4_000);
		expect(service.computeLoginBackoffMs(5)).toBe(32_000);
		expect(service.computeLoginBackoffMs(6)).toBe(60_000);
		expect(service.computeLoginBackoffMs(20)).toBe(60_000);
	});

	it("throttles the failure heartbeat to at most one per interval", () => {
		const runtime = makeRuntime();
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
		}) as unknown as DiscordService & {
			emitLoginFailureHeartbeat: (
				state: DiscordAccountClientState,
				error: unknown,
				attempt: number,
				delayMs: number,
			) => void;
		};
		const state = makeState("default");
		const error = new Error("The socket connection was closed unexpectedly.");

		vi.setSystemTime(0);
		service.emitLoginFailureHeartbeat(state, error, 0, 1_000);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(1);

		// Inside the 30s throttle window a fast retry storm is suppressed so it
		// cannot flood the log.
		vi.setSystemTime(10_000);
		service.emitLoginFailureHeartbeat(state, error, 1, 2_000);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(1);

		// Past the window the heartbeat fires again, keeping a stuck account
		// observably surfaced.
		vi.setSystemTime(41_000);
		service.emitLoginFailureHeartbeat(state, error, 2, 4_000);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(2);
	});

	it("does not schedule a retry when the first login succeeds", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const service = makeService(runtime, () => {
			const client = makeFakeClient({ kind: "succeed" });
			clients.push(client);
			return client;
		});
		const state = makeState("default");

		await new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject, 0);
		});

		expect(clients.length).toBe(1);
		expect(service.timeouts.length).toBe(0);
		expect(state.loginRetryTimer).toBeUndefined();
		expect(runtime.logger.warn).not.toHaveBeenCalled();
		expect(runtime.reportError).not.toHaveBeenCalled();
	});
});
