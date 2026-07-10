/**
 * Drives the real initial-login retry loop (`DiscordService.attemptDiscordLogin`)
 * against a deterministic fake discord.js client whose `login()` rejects N times
 * then resolves and emits ClientReady. Guards #15855: a transient boot-time
 * login failure must retry with backoff and eventually reach ready — never
 * settle terminal, leaving the process connected-but-deaf. Collaborators that
 * are not under test (event wiring, onReady backfill, legacy aliasing) are
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
		expect(heartbeat?.[0]).toMatchObject({
			accountId: "default",
			error: "The socket connection was closed unexpectedly.",
		});
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
});
