/**
 * Exercises provider roleGate enforcement on the `composeState` onlyInclude
 * path: role-gated providers are dropped for automated (connector-stamped
 * bot/webhook or bridge-source) senders that resolve to GUEST, kept for
 * automated senders with an explicit world role, kept unconditionally for
 * human senders (unassigned humans default to GUEST, so blanket enforcement
 * would strip Stage-1 recall), and the agent's own synthetic turns act as
 * OWNER. Uses a real AgentRuntime + InMemoryDatabaseAdapter with a real world
 * and room; no model.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, Provider, UUID } from "../types";
import { ChannelType } from "../types";

const WORLD_ID = "11111111-1111-1111-1111-111111111110" as UUID;
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const UNASSIGNED_SENDER = "22222222-2222-2222-2222-222222222221" as UUID;
const GRANTED_SENDER = "22222222-2222-2222-2222-222222222222" as UUID;

function staticProvider(name: string, extra: Partial<Provider> = {}): Provider {
	return {
		name,
		get: async () => ({ text: `${name}-content`, values: {}, data: {} }),
		...extra,
	};
}

async function makeRuntime(): Promise<AgentRuntime> {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: { name: "role-gate-test" } as Character,
		adapter,
		logLevel: "fatal",
	});
	await adapter.createWorlds([
		{
			id: WORLD_ID,
			agentId: runtime.agentId,
			name: "test world",
			metadata: { roles: { [GRANTED_SENDER]: "USER" } },
		},
	]);
	await adapter.createRooms([
		{
			id: ROOM_ID,
			agentId: runtime.agentId,
			source: "test",
			type: ChannelType.GROUP,
			worldId: WORLD_ID,
		},
	]);
	runtime.registerProvider(
		staticProvider("GATED", { roleGate: { minRole: "USER" } }),
	);
	runtime.registerProvider(staticProvider("OPEN"));
	return runtime;
}

function makeMessage(
	id: string,
	entityId: UUID,
	contentMetadata?: Record<string, unknown>,
): Memory {
	return {
		id: id as UUID,
		entityId,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		content: { text: "gm", source: "discord", metadata: contentMetadata },
	} as Memory;
}

describe("composeState onlyInclude provider roleGate", () => {
	it("keeps role-gated providers for human senders regardless of world role", async () => {
		const runtime = await makeRuntime();
		const message = makeMessage(
			"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
			UNASSIGNED_SENDER,
		);
		const state = await runtime.composeState(
			message,
			["GATED", "OPEN"],
			true,
			true,
		);
		expect(state.text).toContain("GATED-content");
		expect(state.text).toContain("OPEN-content");
	});

	it("drops role-gated providers for bot-authored senders without a world role", async () => {
		const runtime = await makeRuntime();
		const humanState = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", UNASSIGNED_SENDER),
			["GATED", "OPEN"],
			true,
			true,
		);
		const botState = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3", UNASSIGNED_SENDER, {
				fromBot: true,
			}),
			["GATED", "OPEN"],
			true,
			true,
		);
		expect(botState.text).toContain("OPEN-content");
		expect(botState.text).not.toContain("GATED-content");
		// The prompt footprint drops on the automated turn.
		expect(botState.text.length).toBeLessThan(humanState.text.length);
	});

	it("keeps role-gated providers for bot senders granted an explicit world role", async () => {
		const runtime = await makeRuntime();
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4", GRANTED_SENDER, {
				fromBot: true,
			}),
			["GATED", "OPEN"],
			true,
			true,
		);
		expect(state.text).toContain("GATED-content");
		expect(state.text).toContain("OPEN-content");
	});

	it("treats the agent's own synthetic turns as OWNER", async () => {
		const runtime = await makeRuntime();
		runtime.registerProvider(
			staticProvider("ADMIN_GATED", { roleGate: { minRole: "ADMIN" } }),
		);
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5", runtime.agentId, {
				fromBot: true,
			}),
			["ADMIN_GATED", "OPEN"],
			true,
			true,
		);
		expect(state.text).toContain("ADMIN_GATED-content");
	});
});
