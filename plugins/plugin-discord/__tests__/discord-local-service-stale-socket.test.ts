/**
 * Regression coverage for a stale-socket race in DiscordLocalService's local
 * RPC IPC connection: a socket replaced by a newer ensureRpcConnection() call
 * can still deliver a delayed "close"/"error"/"data" event after the
 * replacement is already live. Unguarded, that stale event nulled out
 * `this.socket` (the CURRENT, live connection) and rejected pending
 * requests that belong to the replacement -- the same bug class fixed today
 * in plugin-native-gateway (#22554), plugin-elizacloud (#22593), and
 * plugin-whatsapp (#22568).
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

// Import after the mocks above are registered so the module under test picks
// them up.
const { DiscordLocalService } = await import("../discord-local-service.ts");

function makeService(): InstanceType<typeof DiscordLocalService> {
	return new DiscordLocalService({
		getSetting(key: string) {
			if (key === "DISCORD_LOCAL_CLIENT_ID") return "client";
			if (key === "DISCORD_LOCAL_CLIENT_SECRET") return "secret";
			return undefined;
		},
	} as never);
}

describe("DiscordLocalService stale local-socket events", () => {
	beforeEach(() => {
		process.env.DISCORD_IPC_DIR = "/tmp";
	});

	afterEach(() => {
		sockets.length = 0;
		vi.restoreAllMocks();
	});

	it("does not let a stale close from a replaced socket clear the live connection", async () => {
		const service = makeService();
		const ensure = (
			service as never as { ensureRpcConnection(): Promise<void> }
		).ensureRpcConnection.bind(service);

		const first = ensure();
		sockets[0].emit("error", new Error("first failed"));
		await expect(first).rejects.toThrow("first failed");

		const second = ensure();
		expect(sockets).toHaveLength(2);

		// The first (now-superseded) socket's close event arrives late.
		sockets[0].emit("close");

		expect((service as never as { socket: FakeSocket | null }).socket).toBe(
			sockets[1],
		);

		sockets[1].emit("error", new Error("second failed"));
		await expect(second).rejects.toThrow("second failed");
	});

	it("nulls the socket on a close with no reconnect pending, so a fresh connect attempt is not blocked", async () => {
		const service = makeService();
		const ensure = (
			service as never as { ensureRpcConnection(): Promise<void> }
		).ensureRpcConnection.bind(service);

		const first = ensure();
		sockets[0].emit("error", new Error("first failed"));
		await expect(first).rejects.toThrow("first failed");
		// No persisted session -> no accessToken -> no reconnect scheduled.
		sockets[0].emit("close");

		expect(
			(service as never as { socket: FakeSocket | null }).socket,
		).toBeNull();
	});
});
