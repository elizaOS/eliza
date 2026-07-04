import { describe, expect, it, vi } from "vitest";
import type { Entity, IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import { messageAddressedToOtherParticipant } from "../addressed-to.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const OTHER_BOT = "00000000-0000-0000-0000-0000000000bb" as UUID;
const HUMAN_X = "00000000-0000-0000-0000-0000000000cc" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "MyAgent" },
		getEntitiesForRoom: vi.fn(async () => [] as Entity[]),
		...overrides,
	} as unknown as IAgentRuntime;
}

function makeMessage(
	contentMetadata?: Record<string, unknown>,
	topLevelMetadata?: Record<string, unknown>,
): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000ee" as UUID,
		entityId: SENDER_ID,
		roomId: ROOM_ID,
		content: {
			text: "do the thing",
			...(contentMetadata ? { metadata: contentMetadata } : {}),
		},
		...(topLevelMetadata ? { metadata: topLevelMetadata } : {}),
	} as Memory;
}

// Room with this agent plus two other resolvable participants — one bot, one
// human — so name→id resolution works and the human/bot cases are symmetric.
function roomWithOthers(): Partial<IAgentRuntime> {
	return {
		getEntitiesForRoom: vi.fn(async () => [
			{ id: AGENT_ID, names: ["MyAgent", "myagent_bot"] },
			{ id: OTHER_BOT, names: ["SomeOtherBot"] },
			{ id: HUMAN_X, names: ["Alice"] },
		]),
	} as unknown as Partial<IAgentRuntime>;
}

describe("messageAddressedToOtherParticipant (#9874 — uniform addressing gate)", () => {
	it("returns false when there are no explicit addressees (DMs / undirected asks)", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: [],
			}),
		).toBe(false);
	});

	it("returns false when addressed to this agent by name (case/@-insensitive)", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: ["@myagent"],
			}),
		).toBe(false);
	});

	it("returns false when addressed to this agent by id", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: [AGENT_ID],
			}),
		).toBe(false);
	});

	it("returns true when addressed to another bot participant (by id)", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: [OTHER_BOT],
			}),
		).toBe(true);
	});

	it("returns true when addressed to another bot participant (resolved by name)", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: ["@SomeOtherBot"],
			}),
		).toBe(true);
	});

	it("returns true when addressed to a HUMAN participant — same as a bot (uniform, not bot-specific)", async () => {
		// The decisive change from the bot-specific version: a turn directed at a
		// human who is not us is overheard crosstalk too, and is gated identically.
		// Bot-ness is never consulted here.
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: ["Alice"],
			}),
		).toBe(true);
	});

	it("does NOT depend on the sender being a bot — fromBot is irrelevant to the gate", async () => {
		// A non-bot sender addressing another participant still gates (no fromBot /
		// getAgent requirement)...
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: ["Alice"],
			}),
		).toBe(true);
		// ...and a bot sender addressing an UNRESOLVABLE name does NOT gate
		// structurally: fromBot is no longer a trigger, so this residual overheard
		// crosstalk is left to the model + the "(bot)" transcript tag (either
		// content-level or legacy top-level fromBot).
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(),
				message: makeMessage({ fromBot: true }),
				addressedTo: ["@ghost"],
			}),
		).toBe(false);
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(),
				message: makeMessage(undefined, { fromBot: true }),
				addressedTo: ["@ghost"],
			}),
		).toBe(false);
	});

	it("fails safe (false) when an addressed bare name cannot be resolved to a real participant", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(),
				message: makeMessage(),
				addressedTo: ["@ghost"],
			}),
		).toBe(false);
	});

	it("returns false when addressed to us by a platform-handle ALIAS (resolved to self, not character.name)", async () => {
		// The agent's room entity carries platform aliases (e.g. samantha_ai_bot)
		// that are not character.name. A turn addressed to us by such an alias must
		// resolve to self and NOT be mistaken for an other-participant address.
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, names: ["samantha_ai_bot", "Samantha"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage({ fromBot: true }),
				addressedTo: ["@samantha_ai_bot"],
			}),
		).toBe(false);
	});

	it("returns false when addressed to us AND another participant (we are among the addressees)", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: ["@myagent", "@SomeOtherBot"],
			}),
		).toBe(false);
	});
});
