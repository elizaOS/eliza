/**
 * `VoiceManager` voice-connection lifecycle: the per-connection `stateChange`
 * listener installed by `joinChannel()` must never act on a connection it no
 * longer owns, and must never be installed twice on one connection.
 *
 * These run against the real `@discordjs/voice` stack driven through a stub
 * voice adapter (no gateway socket), so `joinVoiceChannel()` de-duplication and
 * `VoiceConnection.destroy()`'s throw-on-already-destroyed behave exactly as
 * they do in production.
 */
import { EventEmitter } from "node:events";
import { ChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ICompatRuntime } from "../compat";
import { VoiceManager } from "../voice";

/** The Disconnected handler probes for a reconnect for 5s before cleaning up. */
const RECONNECT_PROBE_MS = 5_000;

function makeRuntime() {
	return {
		agentId: "00000000-0000-4000-8000-000000000002",
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	};
}

function makeChannel(guildId: string) {
	return {
		guildId,
		id: `voice-${guildId}`,
		name: "Owners Room",
		members: new Map(),
		type: ChannelType.GuildVoice,
		guild: {
			id: guildId,
			members: { fetch: vi.fn() },
			voiceAdapterCreator: () => ({
				sendPayload: () => true,
				destroy: () => undefined,
			}),
		},
	};
}

function makeManager(unregisterVoiceTarget?: (...args: string[]) => void) {
	const client = new EventEmitter() as EventEmitter & { user?: { id: string } };
	client.user = { id: "bot-1" };
	return new VoiceManager(
		{ accountId: "test", client: client as never, unregisterVoiceTarget },
		makeRuntime() as unknown as ICompatRuntime,
	);
}

/** Discord close code 4014: "do not reconnect" — the real disconnect path. */
function closeWithoutReconnect(connection: unknown) {
	(connection as { onNetworkingClose(code: number): void }).onNetworkingClose(
		4014,
	);
}

async function afterReconnectProbe() {
	await new Promise((resolve) =>
		setTimeout(resolve, RECONNECT_PROBE_MS + 1_000),
	);
	await new Promise((resolve) => setImmediate(resolve));
}

describe("VoiceManager voice-connection lifecycle", () => {
	let rejections: unknown[] = [];
	let onRejection: (reason: unknown) => void;

	const rejectionMessages = () =>
		rejections.map((r) => (r instanceof Error ? r.message : String(r)));

	beforeEach(() => {
		rejections = [];
		onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
	});

	afterEach(() => {
		process.off("unhandledRejection", onRejection);
	});

	it("survives a leave issued while the reconnect probe is still open", async () => {
		const manager = makeManager();
		const channel = makeChannel("guild-leave");
		await manager.joinChannel(channel as never);

		const connection = manager.getVoiceConnection("guild-leave");
		expect(connection).toBeDefined();
		if (!connection) return;

		closeWithoutReconnect(connection);
		expect(connection.state.status).toBe("disconnected");

		// `/voice mode:leave` lands inside the 5s reconnect probe window.
		manager.leaveChannel(channel as never);
		expect(connection.state.status).toBe("destroyed");

		await afterReconnectProbe();

		expect(rejectionMessages()).toEqual([]);
		expect(manager.getVoiceConnection("guild-leave")).toBeUndefined();
	}, 30_000);

	it("installs exactly one lifecycle listener when two joins overlap", async () => {
		const manager = makeManager();
		const channel = makeChannel("guild-overlap");
		await Promise.all([
			manager.joinChannel(channel as never),
			manager.joinChannel(channel as never),
		]);

		const connection = manager.getVoiceConnection("guild-overlap");
		expect(connection).toBeDefined();
		if (!connection) return;

		// `error` is not asserted: each still-pending `entersState` loser from
		// `Promise.race` holds one of its own until its 20s deadline.
		expect(connection.listenerCount("stateChange")).toBe(1);
		expect(connection.receiver.speaking.listenerCount("start")).toBe(1);
		expect(connection.receiver.speaking.listenerCount("end")).toBe(1);

		closeWithoutReconnect(connection);
		await afterReconnectProbe();

		expect(rejectionMessages()).toEqual([]);
		// The confirmed disconnect must still tear the channel entry down.
		expect(connection.state.status).toBe("destroyed");
		expect(manager.getVoiceConnection("guild-overlap")).toBeUndefined();
	}, 30_000);

	it("still tears down on an ordinary confirmed disconnect", async () => {
		const unregisterVoiceTarget = vi.fn();
		const manager = makeManager(unregisterVoiceTarget);
		const channel = makeChannel("guild-plain");

		await manager.joinChannel(channel as never);
		const connection = manager.getVoiceConnection("guild-plain");
		expect(connection).toBeDefined();
		if (!connection) return;

		closeWithoutReconnect(connection);
		await afterReconnectProbe();

		expect(connection.state.status).toBe("destroyed");
		expect(manager.getVoiceConnection("guild-plain")).toBeUndefined();
		expect(unregisterVoiceTarget).toHaveBeenCalledWith(
			"test",
			"guild-plain",
			"voice-guild-plain",
		);
		expect(rejectionMessages()).toEqual([]);
	}, 30_000);
});
