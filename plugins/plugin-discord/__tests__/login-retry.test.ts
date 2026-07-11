/**
 * Drives the real initial-login retry loop (`DiscordService.attemptDiscordLogin`)
 * against a deterministic fake discord.js client whose `login()` rejects N times
 * then resolves and emits ClientReady, plus focused checks of the real backoff
 * (`computeLoginBackoffMs`) and throttled failure heartbeat
 * (`emitLoginFailureHeartbeat`). Guards #15855: a transient boot-time login
 * failure must retry with capped-exponential backoff and eventually reach ready
 * — never settle terminal, leaving the process connected-but-deaf. Collaborators
 * that are not under test (event wiring, onReady backfill, legacy aliasing) are
 * stubbed on the instance; the retry/backoff/heartbeat code runs for real.
 */
import { Events } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordAccountClientState } from "../account-client-pool.ts";
import { DiscordService } from "../service.ts";

type FakeClient = {
	once: (event: string, cb: (...args: unknown[]) => void) => FakeClient;
	on: () => FakeClient;
	login: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	isReady: () => boolean;
	emit: (event: string, ...args: unknown[]) => void;
};

const GATEWAY_CLOSE_ABNORMAL = 1006;
const GATEWAY_CLOSE_DISALLOWED_INTENTS = 4014;

function makeFakeClient(shouldSucceed: boolean): FakeClient {
	const handlers = new Map<string, (...args: unknown[]) => void>();
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
		login: vi.fn().mockImplementation(async () => {
			if (!shouldSucceed) {
				throw new Error("The socket connection was closed unexpectedly.");
			}
			// discord.js emits ClientReady asynchronously once the gateway session
			// is up; mirror that so the ready handler fires after login resolves.
			queueMicrotask(() => client.emit(Events.ClientReady, client));
			return "token";
		}),
	};
	return client;
}

function makeNeverReadyClient(): FakeClient {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	const client: FakeClient = {
		once(event, cb) {
			handlers.set(event, cb);
			return client;
		},
		on: () => client,
		destroy: vi.fn().mockResolvedValue(undefined),
		isReady: () => false,
		emit(event, ...args) {
			handlers.get(event)?.(...args);
		},
		login: vi.fn().mockReturnValue(new Promise(() => undefined)),
	};
	return client;
}

function makeInvalidTokenClient(): FakeClient {
	const client = makeNeverReadyClient();
	client.login.mockRejectedValue(
		Object.assign(new Error("An invalid token was provided."), {
			code: "TokenInvalid",
		}),
	);
	return client;
}

function makeRuntime() {
	return {
		agentId: "agent-1",
		character: { name: "Eliza" },
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

describe("DiscordService initial-login retry (#15855)", () => {
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

		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: "default",
			_loginFailed: false,
			timeouts: [] as ReturnType<typeof setTimeout>[],
			createDiscordJsClient: () => {
				const client = makeFakeClient(clients.length >= FAIL_TIMES);
				clients.push(client);
				return client;
			},
			// Isolate the retry loop from the heavy gateway/backfill collaborators.
			setupEventListenersForAccount: vi.fn(),
			onReadyForAccount: vi.fn().mockResolvedValue(undefined),
			syncLegacyDefaultAliases: vi.fn(),
		}) as unknown as DiscordService & {
			attemptDiscordLogin: (
				state: DiscordAccountClientState,
				token: string,
				attempt: number,
				resolve: () => void,
				reject: (error: unknown) => void,
			) => void;
			_loginFailed: boolean;
		};

		const state = makeState("default");
		let readyResolved = false;

		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject);
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
	});

	it("runs the ready handler exactly once across retried logins", async () => {
		// onReadyForAccount drives slash-command registration; a ready handler
		// firing once per ATTEMPT (rather than once per successful session) would
		// register every command repeatedly — the guild-scope duplicate shape.
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];
		const onReadyForAccount = vi.fn().mockResolvedValue(undefined);

		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: "default",
			_loginFailed: false,
			timeouts: [] as ReturnType<typeof setTimeout>[],
			createDiscordJsClient: () => {
				const client = makeFakeClient(clients.length >= 2);
				clients.push(client);
				return client;
			},
			setupEventListenersForAccount: vi.fn(),
			onReadyForAccount,
			syncLegacyDefaultAliases: vi.fn(),
		}) as unknown as DiscordService & {
			attemptDiscordLogin: (
				state: DiscordAccountClientState,
				token: string,
				attempt: number,
				resolve: () => void,
				reject: (error: unknown) => void,
			) => void;
		};

		const state = makeState("default");
		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject);
		});
		await vi.advanceTimersByTimeAsync(5_000);
		await ready;

		expect(clients.length).toBe(3);
		expect(onReadyForAccount).toHaveBeenCalledTimes(1);
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

		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: "default",
			_loginFailed: false,
			timeouts: [] as ReturnType<typeof setTimeout>[],
			createDiscordJsClient: () => {
				const client = makeFakeClient(true);
				clients.push(client);
				return client;
			},
			setupEventListenersForAccount: vi.fn(),
			onReadyForAccount: vi.fn().mockResolvedValue(undefined),
			syncLegacyDefaultAliases: vi.fn(),
		}) as unknown as DiscordService & {
			attemptDiscordLogin: (
				state: DiscordAccountClientState,
				token: string,
				attempt: number,
				resolve: () => void,
				reject: (error: unknown) => void,
			) => void;
			timeouts: ReturnType<typeof setTimeout>[];
		};

		const state = makeState("default");
		await new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject);
		});

		expect(clients.length).toBe(1);
		expect(service.timeouts.length).toBe(0);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});

	it("rejects the in-flight ready wait when stop interrupts initial login", async () => {
		const runtime = makeRuntime();
		const client = makeNeverReadyClient();
		const state = makeState("default");
		state.client = client as never;

		const accountPool = {
			list: vi.fn(() => [state]),
			clear: vi.fn(),
		};
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: "default",
			_loginFailed: false,
			timeouts: [] as ReturnType<typeof setTimeout>[],
			accountPool,
			voiceTargets: {
				unregisterAccount: vi.fn(),
				clear: vi.fn(),
			},
			audioSinks: new Map(),
			createDiscordJsClient: () => client,
			setupEventListenersForAccount: vi.fn(),
			onReadyForAccount: vi.fn().mockResolvedValue(undefined),
			syncLegacyDefaultAliases: vi.fn(),
		}) as unknown as DiscordService & {
			attemptDiscordLogin: (
				state: DiscordAccountClientState,
				token: string,
				attempt: number,
				resolve: () => void,
				reject: (error: unknown) => void,
			) => void;
		};

		state.clientReadyPromise = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject);
		});
		const observedReady = state.clientReadyPromise.then(
			() => "resolved" as const,
			(error) => (error instanceof Error ? error.message : String(error)),
		);

		await service.stop();
		const settlement = await Promise.race([
			observedReady,
			Promise.resolve("pending" as const),
		]);

		expect(settlement).toMatch(/stopped/i);
		expect(client.destroy).toHaveBeenCalledTimes(1);
		expect(accountPool.clear).toHaveBeenCalledTimes(1);
	});

	it("classifies terminal gateway close during initial login and does not retry", async () => {
		const runtime = makeRuntime();
		const client = makeNeverReadyClient();

		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: "default",
			_loginFailed: false,
			timeouts: [] as ReturnType<typeof setTimeout>[],
			createDiscordJsClient: () => client,
			setupEventListenersForAccount: vi.fn(),
			onReadyForAccount: vi.fn().mockResolvedValue(undefined),
			syncLegacyDefaultAliases: vi.fn(),
		}) as unknown as DiscordService & {
			attemptDiscordLogin: (
				state: DiscordAccountClientState,
				token: string,
				attempt: number,
				resolve: () => void,
				reject: (error: unknown) => void,
			) => void;
			timeouts: ReturnType<typeof setTimeout>[];
		};

		const state = makeState("default");
		state.client = client as never;
		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject);
		});
		const terminalReady = expect(ready).rejects.toThrow(/terminal/i);

		client.emit(Events.ShardDisconnect, {
			code: GATEWAY_CLOSE_DISALLOWED_INTENTS,
			reason: "Disallowed intents",
			wasClean: false,
		});

		await terminalReady;
		await vi.advanceTimersByTimeAsync(120_000);

		expect(client.login).toHaveBeenCalledTimes(1);
		expect(service.timeouts).toHaveLength(0);
		expect(state.loginRetryTimer).toBeUndefined();
		expect(runtime.logger.warn).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.stringContaining("connected-but-deaf"),
		);
		expect(runtime.logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				closeCode: GATEWAY_CLOSE_DISALLOWED_INTENTS,
			}),
			expect.stringContaining("terminal"),
		);
	});

	it("classifies a pre-gateway invalid-token rejection without waiting for a shard close", async () => {
		const runtime = makeRuntime();
		const client = makeInvalidTokenClient();
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: "default",
			_loginFailed: false,
			timeouts: [] as ReturnType<typeof setTimeout>[],
			createDiscordJsClient: () => client,
			setupEventListenersForAccount: vi.fn(),
			onReadyForAccount: vi.fn().mockResolvedValue(undefined),
			syncLegacyDefaultAliases: vi.fn(),
		}) as unknown as DiscordService & {
			attemptDiscordLogin: (
				state: DiscordAccountClientState,
				token: string,
				attempt: number,
				resolve: () => void,
				reject: (error: unknown) => void,
			) => void;
			timeouts: ReturnType<typeof setTimeout>[];
		};

		const state = makeState("default");
		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "invalid-token", 0, resolve, reject);
		});

		await expect(ready).rejects.toThrow(/terminal/i);
		await vi.advanceTimersByTimeAsync(120_000);

		expect(client.login).toHaveBeenCalledTimes(1);
		expect(service.timeouts).toHaveLength(0);
		expect(state.loginRetryTimer).toBeUndefined();
	});

	it("still retries transient gateway close during initial login", async () => {
		const runtime = makeRuntime();
		const clients: FakeClient[] = [];

		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: "default",
			_loginFailed: false,
			timeouts: [] as ReturnType<typeof setTimeout>[],
			createDiscordJsClient: () => {
				const client =
					clients.length === 0 ? makeNeverReadyClient() : makeFakeClient(true);
				clients.push(client);
				return client;
			},
			setupEventListenersForAccount: vi.fn(),
			onReadyForAccount: vi.fn().mockResolvedValue(undefined),
			syncLegacyDefaultAliases: vi.fn(),
		}) as unknown as DiscordService & {
			attemptDiscordLogin: (
				state: DiscordAccountClientState,
				token: string,
				attempt: number,
				resolve: () => void,
				reject: (error: unknown) => void,
			) => void;
		};

		const state = makeState("default");
		const ready = new Promise<void>((resolve, reject) => {
			service.attemptDiscordLogin(state, "bot-token", 0, resolve, reject);
		});

		clients[0]?.emit(Events.ShardDisconnect, {
			code: GATEWAY_CLOSE_ABNORMAL,
			reason: "Transient gateway close",
			wasClean: false,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await ready;

		expect(clients).toHaveLength(2);
		expect(state.loginFailed).toBe(false);
		expect(state.loginRetryTimer).toBeUndefined();
	});
});
