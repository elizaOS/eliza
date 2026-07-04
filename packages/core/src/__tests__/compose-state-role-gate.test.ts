/**
 * Pins that the `composeState` onlyInclude path honors the explicit provider
 * list without enforcing declared roleGates, for every sender kind. Stage-1
 * force-includes recall providers (FACTS declares minRole USER) for all
 * senders, and both unassigned humans AND relay/webhook bridges resolve to
 * GUEST by default — so gate enforcement here would strip cross-turn recall
 * from relayed human conversation (the ZenithProxy pattern). Uses a real
 * AgentRuntime + InMemoryDatabaseAdapter with a real world and room; no model.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, Provider, UUID } from "../types";
import { ChannelType } from "../types";

const WORLD_ID = "11111111-1111-1111-1111-111111111110" as UUID;
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const UNASSIGNED_SENDER = "22222222-2222-2222-2222-222222222221" as UUID;

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
			metadata: { roles: {} },
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
	overrides: {
		contentMetadata?: Record<string, unknown>;
		source?: string;
	} = {},
): Memory {
	return {
		id: id as UUID,
		entityId,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		content: {
			text: "gm",
			source: overrides.source ?? "discord",
			metadata: overrides.contentMetadata,
		},
	} as Memory;
}

describe("composeState onlyInclude ignores provider roleGates", () => {
	it("keeps role-gated providers for human senders without a world role", async () => {
		const runtime = await makeRuntime();
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", UNASSIGNED_SENDER),
			["GATED", "OPEN"],
			true,
			true,
		);
		expect(state.text).toContain("GATED-content");
		expect(state.text).toContain("OPEN-content");
	});

	it("keeps role-gated providers for bot-authored senders without a world role", async () => {
		// A roleless relay webhook resolves to GUEST; if the gate were enforced
		// here, FACTS-style recall providers would silently vanish from every
		// relayed human turn.
		const runtime = await makeRuntime();
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", UNASSIGNED_SENDER, {
				contentMetadata: { fromBot: true },
			}),
			["GATED", "OPEN"],
			true,
			true,
		);
		expect(state.text).toContain("GATED-content");
		expect(state.text).toContain("OPEN-content");
	});

	it("keeps role-gated providers for internal bridge sources without a world role", async () => {
		const runtime = await makeRuntime();
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3", UNASSIGNED_SENDER, {
				source: "acpx:sub-agent-router",
			}),
			["GATED", "OPEN"],
			true,
			true,
		);
		expect(state.text).toContain("GATED-content");
		expect(state.text).toContain("OPEN-content");
	});
});
