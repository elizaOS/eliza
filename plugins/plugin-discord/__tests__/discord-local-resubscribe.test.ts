/**
 * Regression coverage for a lost-subscription bug in DiscordLocalService.
 *
 * Discord RPC subscriptions are bound to the IPC *connection* — they die with
 * the socket, which is why the "close" handler already resets `authenticated`.
 * `subscribedChannelIds` was not reset with it, so after any reconnect
 * `subscribeConfiguredChannels()` found every configured channel still latched
 * and sent zero SUBSCRIBE frames. The connection came back live and
 * authenticated, `getStatus()` still reported the channels as subscribed, and
 * no MESSAGE_CREATE ever arrived again.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket extends EventEmitter {
	destroyed = false;
	write = vi.fn(() => true);
	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

const sockets: FakeSocket[] = [];

vi.mock("node:net", () => ({
	default: {
		createConnection: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
	},
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, default: { ...actual, existsSync: () => true } };
});

vi.mock("@elizaos/core", () => ({
	ChannelType: {},
	ContentType: {},
	Service: class Service {
		runtime: unknown;
		constructor(runtime?: unknown) {
			this.runtime = runtime;
		}
	},
	createMessageMemory: vi.fn(),
	createUniqueUuid: vi.fn(),
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
	resolveStateDir: () => "/tmp",
	stringToUuid: vi.fn(),
}));

const { DiscordLocalService } = await import("../discord-local-service.ts");

interface SentCommand {
	command: string;
	args?: Record<string, unknown>;
	event?: string;
}

interface ServiceState {
	ensureRpcConnection(): Promise<void>;
	subscribeConfiguredChannels(): Promise<void>;
	sendRpcCommand: (
		command: string,
		args?: Record<string, unknown>,
		event?: string,
	) => Promise<unknown>;
	connectorConfig: { messageChannelIds: string[] } | null;
	session: { accessToken: string; scopes: string[] } | null;
	subscribedChannelIds: Set<string>;
	socket: FakeSocket | null;
}

function makeService(): { service: unknown; state: ServiceState } {
	const service = new DiscordLocalService({
		getSetting(key: string) {
			if (key === "DISCORD_LOCAL_CLIENT_ID") return "client";
			if (key === "DISCORD_LOCAL_CLIENT_SECRET") return "secret";
			return undefined;
		},
	} as never);
	return { service, state: service as never as ServiceState };
}

describe("DiscordLocalService re-subscribes after a reconnect", () => {
	beforeEach(() => {
		// The local IPC service is macOS-only; exercise that path on Linux CI too.
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		process.env.DISCORD_IPC_DIR = "/tmp";
	});

	afterEach(() => {
		sockets.length = 0;
		vi.restoreAllMocks();
	});

	it("sends SUBSCRIBE again for every configured channel after the socket closes", async () => {
		const { state } = makeService();
		const sent: SentCommand[] = [];
		state.sendRpcCommand = async (command, args, event) => {
			sent.push({ command, args, event });
			return {};
		};
		state.connectorConfig = { messageChannelIds: ["chan-a", "chan-b"] };
		// A persisted session is what makes "close" schedule a reconnect instead
		// of tearing down for good.
		state.session = { accessToken: "persisted", scopes: [] };

		const connecting = state.ensureRpcConnection();
		await state.subscribeConfiguredChannels();

		const firstPass = sent.filter((entry) => entry.command === "SUBSCRIBE");
		expect(firstPass).toHaveLength(2);
		expect(firstPass.map((entry) => entry.args?.channel_id)).toEqual([
			"chan-a",
			"chan-b",
		]);

		// The Discord desktop app quits (or sends IPC_OP_CLOSE) and the socket dies.
		sockets[0].emit("close");
		await expect(connecting).rejects.toThrow("connection closed");

		// The reconnect path re-authenticates and re-subscribes. Every configured
		// channel must be sent again: the old subscriptions died with the socket.
		await state.subscribeConfiguredChannels();

		const allSubscribes = sent.filter((entry) => entry.command === "SUBSCRIBE");
		expect(allSubscribes).toHaveLength(4);
		expect(
			allSubscribes.slice(2).map((entry) => entry.args?.channel_id),
		).toEqual(["chan-a", "chan-b"]);
	});

	it("clears the latched subscriptions when the socket closes", async () => {
		const { state } = makeService();
		state.sendRpcCommand = async () => ({});
		state.connectorConfig = { messageChannelIds: ["chan-a"] };
		state.session = { accessToken: "persisted", scopes: [] };

		const connecting = state.ensureRpcConnection();
		await state.subscribeConfiguredChannels();
		expect([...state.subscribedChannelIds]).toEqual(["chan-a"]);

		sockets[0].emit("close");
		await expect(connecting).rejects.toThrow("connection closed");

		expect([...state.subscribedChannelIds]).toEqual([]);
	});

	it("clears the latched subscriptions on stop()", async () => {
		const { service, state } = makeService();
		state.sendRpcCommand = async () => ({});
		state.connectorConfig = { messageChannelIds: ["chan-a"] };

		const connecting = state.ensureRpcConnection();
		await state.subscribeConfiguredChannels();
		expect([...state.subscribedChannelIds]).toEqual(["chan-a"]);

		await (service as { stop(): Promise<void> }).stop();
		await expect(connecting).rejects.toThrow("service stopped");

		expect([...state.subscribedChannelIds]).toEqual([]);
	});

	// --- compatibility: the latch still does its original job ---

	it("still does not re-SUBSCRIBE a channel on a live connection", async () => {
		const { state } = makeService();
		const sent: SentCommand[] = [];
		state.sendRpcCommand = async (command, args, event) => {
			sent.push({ command, args, event });
			return {};
		};
		state.connectorConfig = { messageChannelIds: ["chan-a", "chan-b"] };

		// No connection loss in this test, so no socket is needed:
		// subscribeConfiguredChannels only talks through sendRpcCommand.
		await state.subscribeConfiguredChannels();
		// Called twice with no connection loss in between: the second pass must be
		// a no-op, exactly as before.
		await state.subscribeConfiguredChannels();

		expect(sent.filter((entry) => entry.command === "SUBSCRIBE")).toHaveLength(
			2,
		);
	});
});
