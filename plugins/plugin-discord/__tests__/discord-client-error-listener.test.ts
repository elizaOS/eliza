/**
 * Regression coverage for a client-wide crash path in the initial-login setup.
 *
 * discord.js constructs its Client with `captureRejections: true`
 * (`discord.js/src/client/BaseClient.js`) and defines no
 * `Symbol.for("nodejs.rejection")` handler. Under that flag Node routes a
 * rejected async listener into `emitter.emit("error", reason)`, and
 * `EventEmitter#emit("error")` with NO "error" listener rethrows on a
 * `process.nextTick` stack — an uncaughtException no call-stack try/catch can
 * reach, which the agent crash guard turns into a whole-process restart.
 *
 * `attemptDiscordLogin` registered the client's only "error" listener with
 * `once(...)`, so the first rejecting gateway listener consumed it and the
 * client ran error-listener-less from the second rejection on.
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordAccountClientState } from "../account-client-pool.ts";
import { DiscordService } from "../service.ts";

type Handler = (...args: unknown[]) => void;

interface RecordingClient {
	on: (event: string, cb: Handler) => RecordingClient;
	once: (event: string, cb: Handler) => RecordingClient;
	login: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	isReady: () => boolean;
	emit: (event: string, ...args: unknown[]) => void;
	durable: Map<string, Handler[]>;
	single: Map<string, Handler[]>;
}

function makeRecordingClient(): RecordingClient {
	const durable = new Map<string, Handler[]>();
	const single = new Map<string, Handler[]>();
	const client: RecordingClient = {
		durable,
		single,
		on(event, cb) {
			durable.set(event, [...(durable.get(event) ?? []), cb]);
			return client;
		},
		once(event, cb) {
			single.set(event, [...(single.get(event) ?? []), cb]);
			return client;
		},
		destroy: vi.fn().mockResolvedValue(undefined),
		isReady: () => false,
		emit(event, ...args) {
			for (const cb of durable.get(event) ?? []) cb(...args);
			const pending = single.get(event) ?? [];
			// `once` handlers are consumed — this is the mechanism under test.
			single.set(event, []);
			for (const cb of pending) cb(...args);
		},
		// Never settles: keeps the attempt alive so we can drive Error ourselves.
		login: vi.fn().mockReturnValue(new Promise(() => undefined)),
	};
	return client;
}

function makeRuntime() {
	return {
		agentId: "agent-1",
		character: { name: "Eliza" },
		logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
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

function makeService(client: RecordingClient) {
	const runtime = makeRuntime();
	const service = Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		defaultAccountId: "default",
		_loginFailed: false,
		timeouts: [] as ReturnType<typeof setTimeout>[],
		createDiscordJsClient: () => client,
		setupEventListenersForAccount: vi.fn(),
		onReadyForAccount: vi.fn().mockResolvedValue(undefined),
		syncLegacyDefaultAliases: vi.fn(),
		emitLoginFailureHeartbeat: vi.fn(),
	}) as unknown as DiscordService & {
		attemptDiscordLogin: (
			state: DiscordAccountClientState,
			token: string,
			attempt: number,
			resolve: () => void,
			reject: (error: unknown) => void,
		) => void;
	};
	return { service, runtime };
}

describe("Discord client keeps a durable 'error' listener", () => {
	it("registers error handling with on(), not only once()", () => {
		const client = makeRecordingClient();
		const { service } = makeService(client);
		service.attemptDiscordLogin(
			makeState("default"),
			"bot-token",
			0,
			vi.fn(),
			vi.fn(),
		);

		// Without a durable listener the client is error-listener-less after the
		// first emit, and discord.js's captureRejections turns the next rejected
		// gateway listener into an uncaughtException.
		expect(client.durable.get(Events.Error) ?? []).toHaveLength(1);
	});

	it("still logs every client error after the per-attempt once() is consumed", () => {
		const client = makeRecordingClient();
		const { service, runtime } = makeService(client);
		service.attemptDiscordLogin(
			makeState("default"),
			"bot-token",
			0,
			vi.fn(),
			vi.fn(),
		);

		client.emit(Events.Error, new Error("gateway blew up once"));
		client.emit(Events.Error, new Error("gateway blew up twice"));
		client.emit(Events.Error, new Error("gateway blew up thrice"));

		const logged = runtime.logger.error.mock.calls.map((call) =>
			String(call[0]),
		);
		expect(logged).toEqual([
			"Discord client error for account default: gateway blew up once",
			"Discord client error for account default: gateway blew up twice",
			"Discord client error for account default: gateway blew up thrice",
		]);
	});

	it("still logs a single error exactly once (no double logging)", () => {
		const client = makeRecordingClient();
		const { service, runtime } = makeService(client);
		service.attemptDiscordLogin(
			makeState("default"),
			"bot-token",
			0,
			vi.fn(),
			vi.fn(),
		);

		client.emit(Events.Error, new Error("only once please"));

		expect(runtime.logger.error).toHaveBeenCalledTimes(1);
		expect(String(runtime.logger.error.mock.calls[0][0])).toBe(
			"Discord client error for account default: only once please",
		);
	});

	// --- the two library facts this defect rests on ---

	it("pins the discord.js behaviour that makes a missing listener fatal", () => {
		const real = new Client({ intents: [GatewayIntentBits.Guilds] });
		// No custom rejection hook, so captured rejections go to emit("error").
		expect(
			(real as unknown as Record<symbol, unknown>)[
				Symbol.for("nodejs.rejection")
			],
		).toBeUndefined();
		// And the library ships no "error" listener of its own.
		expect(real.listenerCount(Events.Error)).toBe(0);
	});
});
