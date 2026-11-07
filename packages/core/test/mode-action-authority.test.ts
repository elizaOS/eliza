/** Real SQLite authority changes during asynchronous hook admission. */
import { expect, it } from "vitest";
import { EventType } from "../src/types/events";
import type { Memory } from "../src/types/memory";
import { ChannelType, type UUID } from "../src/types/primitives";
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

it("reports a handler that returns success:false as a failed action, not completed", async () => {
	const runtime = await createInitializedRuntime({
		character: { name: "Failed hook", bio: [] },
		logLevel: "fatal",
	});
	const worldId = "55555555-5555-4555-8555-555555555555" as UUID;
	const roomId = "66666666-6666-4666-8666-666666666666" as UUID;
	const entityId = "77777777-7777-4777-8777-777777777777" as UUID;
	await runtime.createWorlds([
		{
			id: worldId,
			agentId: runtime.agentId,
			name: "Failure",
			metadata: { roles: { [entityId]: "ADMIN" } },
		},
	]);
	await runtime.createRooms([
		{
			id: roomId,
			agentId: runtime.agentId,
			worldId,
			source: "test",
			type: ChannelType.GROUP,
		},
	]);

	// A hook action whose handler completes normally but reports failure by
	// RETURNING { success: false } — e.g. a security evaluator signalling a block.
	runtime.registerAction({
		name: "RETURN_FAILURE_HOOK",
		description: "Returns an explicit failure without throwing",
		similes: [],
		examples: [],
		mode: "ALWAYS_AFTER",
		validate: async () => true,
		handler: async () => ({ success: false, error: "denied" }),
	});

	const completed: Array<{ actionStatus?: string; error?: unknown }> = [];
	runtime.registerEvent(EventType.ACTION_COMPLETED, async (payload) => {
		const content = (payload as { content?: Record<string, unknown> }).content;
		if (
			content?.actions &&
			(content.actions as string[])[0] === "RETURN_FAILURE_HOOK"
		) {
			completed.push({
				actionStatus: content.actionStatus as string | undefined,
				error: content.error,
			});
		}
	});

	const message: Memory = {
		id: "88888888-8888-4888-8888-888888888888" as UUID,
		agentId: runtime.agentId,
		entityId,
		roomId,
		worldId,
		content: { text: "Run failing hook", source: "test" },
	};
	await runtime.runActionsByMode("ALWAYS_AFTER", message, {
		values: {},
		data: {},
		text: "",
	});

	expect(completed).toHaveLength(1);
	// Before the fix this was "completed" with no error — a fabricated success.
	expect(completed[0]?.actionStatus).toBe("failed");
	expect(completed[0]?.error).toBe("denied");
});
