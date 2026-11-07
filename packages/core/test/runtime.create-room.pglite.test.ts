/**
 * runtime.createRoom must persist the room's metadata. Connectors (Slack)
 * create rooms through it and later read the account and thread back from
 * room.metadata to route sends by roomId. Drives a real AgentRuntime on an
 * in-memory PGlite database (plugin-sql).
 */

import pluginSql from "@elizaos/plugin-sql";
import { afterEach, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime";
import { ChannelType } from "../src/types/primitives";
import { stringToUuid } from "../src/utils/string-to-uuid.js";

let databases = 0;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createRuntime(): Promise<AgentRuntime> {
	const previousDataDir = process.env.PGLITE_DATA_DIR;
	process.env.PGLITE_DATA_DIR = `memory://create-room-${process.pid}-${++databases}`;
	const runtime = new AgentRuntime({
		character: { name: "CreateRoom", bio: ["Tests room creation"] },
		logLevel: "fatal",
	});
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();
	cleanups.push(async () => {
		await runtime.stop();
		await runtime.close();
		if (previousDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
		else process.env.PGLITE_DATA_DIR = previousDataDir;
	});
	return runtime;
}

it("keeps the metadata a connector passes to createRoom", async () => {
	const runtime = await createRuntime();
	const worldId = stringToUuid(`${runtime.agentId}-slack-workspace`);
	const roomId = stringToUuid(`${runtime.agentId}-slack-thread-room`);
	await runtime.createWorld({
		id: worldId,
		name: "Workspace",
		agentId: runtime.agentId,
	});

	await runtime.createRoom({
		id: roomId,
		name: "general",
		agentId: runtime.agentId,
		source: "slack",
		type: ChannelType.GROUP,
		channelId: "C0123",
		worldId,
		metadata: {
			accountId: "acct-2",
			threadTs: "1712345678.000100",
			slack: { accountId: "acct-2", channelId: "C0123" },
		},
	});

	const room = await runtime.getRoom(roomId);
	expect(room?.metadata).toEqual({
		accountId: "acct-2",
		threadTs: "1712345678.000100",
		slack: { accountId: "acct-2", channelId: "C0123" },
	});
});
