import { describe, expect, it, vi } from "vitest";
import type { Entity, IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import { addresseeIsNonOwnerBot } from "../addressed-to.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const BOT_B = "00000000-0000-0000-0000-0000000000bb" as UUID;
const HUMAN_X = "00000000-0000-0000-0000-0000000000cc" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "MyAgent" },
		getAgent: vi.fn(async () => null),
		getEntitiesForRoom: vi.fn(async () => [] as Entity[]),
		...overrides,
	} as unknown as IAgentRuntime;
}

function makeMessage(metadata?: Record<string, unknown>): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000ee" as UUID,
		entityId: SENDER_ID,
		roomId: ROOM_ID,
		content: { text: "do the thing" },
		metadata,
	} as Memory;
}

describe("addresseeIsNonOwnerBot (#9874 item 1)", () => {
	it("returns false when there are no explicit addressees", async () => {
		expect(
			await addresseeIsNonOwnerBot({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: [],
			}),
		).toBe(false);
	});

	it("returns false when addressed to this agent by name (case/@-insensitive)", async () => {
		expect(
			await addresseeIsNonOwnerBot({
				runtime: makeRuntime(),
				message: makeMessage({ fromBot: true }),
				addressedTo: ["@myagent"],
			}),
		).toBe(false);
	});

	it("returns false when addressed to this agent by id", async () => {
		expect(
			await addresseeIsNonOwnerBot({
				runtime: makeRuntime(),
				message: makeMessage({ fromBot: true }),
				addressedTo: [AGENT_ID],
			}),
		).toBe(false);
	});

	it("returns true when a bot addresses someone other than us (sender fromBot)", async () => {
		expect(
			await addresseeIsNonOwnerBot({
				runtime: makeRuntime(),
				message: makeMessage({ fromBot: true }),
				addressedTo: ["SomeOtherBot"],
			}),
		).toBe(true);
	});

	it("returns true when an addressee resolves to a registered agent (no fromBot)", async () => {
		const getAgent = vi.fn(async (id: UUID) =>
			id === BOT_B ? ({ id: BOT_B } as unknown) : null,
		);
		expect(
			await addresseeIsNonOwnerBot({
				runtime: makeRuntime({ getAgent } as Partial<IAgentRuntime>),
				message: makeMessage(),
				addressedTo: [BOT_B],
			}),
		).toBe(true);
	});

	it("returns false when the addressee is a human (not a registered agent, not fromBot)", async () => {
		expect(
			await addresseeIsNonOwnerBot({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: [HUMAN_X],
			}),
		).toBe(false);
	});

	it("returns false when an addressed name cannot be resolved and the sender is not a bot", async () => {
		expect(
			await addresseeIsNonOwnerBot({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: ["@ghost"],
			}),
		).toBe(false);
	});

	it("returns false when a BOT addresses us by a platform-handle ALIAS (not character.name)", async () => {
		// Regression: the agent's room entity carries platform-handle aliases
		// (e.g. samantha_ai_bot) that are not character.name. A bot addressing us
		// by such an alias must be recognized as addressed-to-us and NOT have its
		// tool request suppressed — the self-by-resolution check runs before the
		// fromBot short-circuit.
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, names: ["samantha_ai_bot", "Samantha"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await addresseeIsNonOwnerBot({
				runtime,
				message: makeMessage({ fromBot: true }),
				addressedTo: ["@samantha_ai_bot"],
			}),
		).toBe(false);
	});
});
