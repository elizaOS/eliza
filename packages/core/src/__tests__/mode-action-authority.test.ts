/** Real SQLite authority changes during asynchronous hook admission. */
import { expect, it } from "vitest";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";
import { createInitializedRuntime } from "./initialized-runtime";

it("rechecks the stored role after hook validation", async () => {
	const runtime = await createInitializedRuntime({
		character: { name: "Hook authority", bio: [] },
		logLevel: "fatal",
	});
	const worldId = "11111111-1111-4111-8111-111111111111" as UUID;
	const roomId = "22222222-2222-4222-8222-222222222222" as UUID;
	const entityId = "33333333-3333-4333-8333-333333333333" as UUID;
	const world = {
		id: worldId,
		agentId: runtime.agentId,
		name: "Authority",
		metadata: { roles: { [entityId]: "ADMIN" } },
	};
	await runtime.createWorlds([world]);
	await runtime.createRooms([
		{
			id: roomId,
			agentId: runtime.agentId,
			worldId,
			source: "test",
			type: ChannelType.GROUP,
		},
	]);
	let validations = 0;
	let effects = 0;
	runtime.registerAction({
		name: "AUTHORITY_TEST_HOOK",
		description: "Test hook",
		similes: [],
		examples: [],
		mode: "ALWAYS_AFTER",
		roleGate: { minRole: "ADMIN" },
		validate: async () => {
			validations++;
			await runtime.updateWorlds([
				{ ...world, metadata: { roles: { [entityId]: "GUEST" } } },
			]);
			return true;
		},
		handler: async () => {
			effects++;
			return { success: true };
		},
	});
	const message: Memory = {
		id: "44444444-4444-4444-8444-444444444444" as UUID,
		agentId: runtime.agentId,
		entityId,
		roomId,
		worldId,
		content: { text: "Run hook", source: "test" },
	};
	await runtime.runActionsByMode("ALWAYS_AFTER", message, {
		values: {},
		data: {},
		text: "",
	});
	expect(validations).toBe(1);
	expect(effects).toBe(0);
});
