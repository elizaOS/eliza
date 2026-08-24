/**
 * The uniform addressing gate messageAddressedToOtherParticipant (#9874):
 * returns true only when a turn is directed at a resolvable OTHER room
 * participant — bot or human alike — resolving @-names to ids via room
 * entities, treating platform-alias self-addresses as self, failing safe on
 * unresolvable names, and never consulting sender bot-ness. Runtime and its
 * entity lookup are vi-mocked; no model or database.
 */
import { describe, expect, it, vi } from "vitest";
import type { Entity, IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import {
	messageAddressedToOtherParticipant,
	messageVocativelyAddressesOtherParticipant,
} from "../addressed-to.ts";

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
	text = "do the thing",
): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000ee" as UUID,
		entityId: SENDER_ID,
		roomId: ROOM_ID,
		content: {
			text,
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
			{ id: SENDER_ID, names: ["nubs"] },
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

	it("returns false when the tag resolves to the message's own AUTHOR (Stage-1 extraction error)", async () => {
		// A message cannot be addressed to its own speaker. Live 2026-08-22:
		// "hello?" / "did u see what i said?" were tagged with the asker's own
		// name and silently suppressed as "another participant".
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: ["nubs"],
			}),
		).toBe(false);
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: [SENDER_ID],
			}),
		).toBe(false);
	});

	it("still returns true when BOTH the author and a corroborated other participant are tagged", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(undefined, undefined, "Alice what do you think"),
				addressedTo: ["nubs", "Alice"],
			}),
		).toBe(true);
	});

	it("returns true when addressed to another bot participant (by id, text-corroborated)", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(undefined, undefined, "SomeOtherBot do the thing"),
				addressedTo: [OTHER_BOT],
			}),
		).toBe(true);
	});

	it("an id tag the text never corroborates does NOT gate (corroboration invariant)", async () => {
		// The deterministic gate may only silence on evidence it can verify:
		// a tag naming a participant the text never addresses is treated as a
		// Stage-1 extraction error, not a license for silence.
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: [OTHER_BOT],
			}),
		).toBe(false);
	});

	it("a hallucinated other-participant tag on a message that never names them does NOT gate", async () => {
		// live 2026-08-22: "nubilio whats the setting …" was tagged as addressed
		// to shaw and silently suppressed; the text never mentions shaw.
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(
					undefined,
					undefined,
					"whats the setting we use to make u always respond",
				),
				addressedTo: ["Alice"],
			}),
		).toBe(false);
	});

	it("returns true when addressed to another bot participant (resolved by name, text-corroborated)", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(
					undefined,
					undefined,
					"@SomeOtherBot can you take this one",
				),
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
				message: makeMessage(undefined, undefined, "Alice do the thing"),
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
				message: makeMessage(undefined, undefined, "Alice do the thing"),
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

	it("propagates a room-lookup failure so the caller's fail-open catch owns it (J4 contract)", async () => {
		// The helper itself does NOT swallow resolution errors: the message
		// service wraps the call in a fail-open catch (a DB hiccup means "don't
		// suppress", never a silenced turn). Keeping the rejection visible here
		// is what makes that caller-side contract testable.
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => {
				throw new Error("room lookup down");
			}),
		} as unknown as Partial<IAgentRuntime>);
		await expect(
			messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage(),
				addressedTo: ["Alice"],
			}),
		).rejects.toThrow("room lookup down");
	});
});

describe("live 2026-08-22 Discord incident regression (nubilio test server)", () => {
	// Each case is a REAL turn from the incident, with Stage-1's actual
	// addressedTo tags. The four silent turns and the correct suppression are
	// pinned exactly as they must behave.
	const room = (): Partial<IAgentRuntime> =>
		({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, names: ["remilio nubilio"] },
				{ id: OTHER_BOT, names: ["Eliza"] },
				{ id: HUMAN_X, names: ["shaw"] },
				{ id: SENDER_ID, names: ["nubs"] },
			]),
		}) as unknown as Partial<IAgentRuntime>;
	const nubilio = (): IAgentRuntime =>
		makeRuntime({
			character: { name: "remilio nubilio" },
			...room(),
		} as Partial<IAgentRuntime>);

	it('never silences "nubilio whats the setting …" on a hallucinated shaw tag', async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(
					undefined,
					undefined,
					"nubilio whats the setting we use to make u always respond, not just to mentions",
				),
				addressedTo: ["shaw"],
			}),
		).toBe(false);
	});

	it('never silences "hello?" on an author self-tag', async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "hello?"),
				addressedTo: ["!                           nubs"],
			}),
		).toBe(false);
	});

	it('never silences "did u see what i said?" on an author self-tag', async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "did u see what i said?"),
				addressedTo: ["!                           nubs"],
			}),
		).toBe(false);
	});

	it('correctly stays silent on "Hey Eliza why not respond" (text-corroborated Eliza tag)', async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "Hey Eliza why not respond"),
				addressedTo: ["Eliza"],
			}),
		).toBe(true);
	});
});

describe("messageVocativelyAddressesOtherParticipant (structural vocative)", () => {
	const room = (): Partial<IAgentRuntime> =>
		({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, names: ["remilio nubilio"] },
				{ id: OTHER_BOT, names: ["Eliza"] },
				{ id: HUMAN_X, names: ["shaw"] },
				{ id: SENDER_ID, names: ["nubs"] },
			]),
		}) as unknown as Partial<IAgentRuntime>;
	const nubilio = (): IAgentRuntime =>
		makeRuntime({
			character: { name: "remilio nubilio" },
			...room(),
		} as Partial<IAgentRuntime>);

	it('gates "hey eliza" — a leading vocative of another participant (live 2026-08-22)', async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "hey eliza"),
			}),
		).toBe(true);
	});

	it('gates "Eliza, can you check this?" — bare-name vocative with comma', async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(
					undefined,
					undefined,
					"Eliza, can you check this?",
				),
			}),
		).toBe(true);
	});

	it("evaluates the complete message when leading whitespace exceeds a preview window", async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(
					undefined,
					undefined,
					`${" ".repeat(100)}Eliza, can you check this?`,
				),
			}),
		).toBe(true);
	});

	it('does NOT gate "i was talking to eliza" — mid-text mention is not a vocative', async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "i was talking to eliza"),
			}),
		).toBe(false);
	});

	it('does NOT gate "can you ping eliza for me" — a request TO US about them', async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "can you ping eliza for me"),
			}),
		).toBe(false);
	});

	it('does NOT gate "nubilio ask eliza to deploy" — opens with OUR name token', async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(
					undefined,
					undefined,
					"nubilio ask eliza to deploy",
				),
			}),
		).toBe(false);
	});

	it("does NOT gate a vocative of the SPEAKER's own name", async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "nubs here, checking in"),
			}),
		).toBe(false);
	});

	it("does NOT gate plain unaddressed chatter", async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "whats going on"),
			}),
		).toBe(false);
	});
});

/**
 * Additive edge coverage for the two exports the suites above do not exercise
 * directly: applyAddressedTo (the relationship-edge persistence write path)
 * and resolveAddressedTargets (deterministic name/id resolution), plus a few
 * gate/vocative boundaries the earlier cases miss. Same vi-mocked-runtime
 * harness; no model or database.
 */
import { applyAddressedTo, resolveAddressedTargets } from "../addressed-to.ts";

const ROOM_ROSTER: Entity[] = [
	{ id: AGENT_ID, agentId: AGENT_ID, names: ["MyAgent", "myagent_bot"] },
	{ id: OTHER_BOT, agentId: AGENT_ID, names: ["SomeOtherBot"] },
	{ id: HUMAN_X, agentId: AGENT_ID, names: ["Alice"] },
	{ id: SENDER_ID, agentId: AGENT_ID, names: ["nubs"] },
];

// Runtime whose room roster and relationship-edge fakes are all held as
// handles so each test can inspect the exact calls the module makes.
function relationalRuntime(
	participants: Entity[] = ROOM_ROSTER,
	existingEdges: Relationship[] = [],
): {
	runtime: IAgentRuntime;
	getEntitiesForRoom: IAgentRuntime["getEntitiesForRoom"];
	getRelationships: IAgentRuntime["getRelationships"];
	createRelationship: IAgentRuntime["createRelationship"];
	updateRelationship: IAgentRuntime["updateRelationship"];
} {
	const getEntitiesForRoom: IAgentRuntime["getEntitiesForRoom"] = vi.fn(
		async () => participants,
	);
	const getRelationships: IAgentRuntime["getRelationships"] = vi.fn(
		async () => existingEdges,
	);
	const createRelationship: IAgentRuntime["createRelationship"] = vi.fn(
		async () => true,
	);
	const updateRelationship: IAgentRuntime["updateRelationship"] = vi.fn(
		async () => {},
	);
	return {
		runtime: makeRuntime({
			getEntitiesForRoom,
			getRelationships,
			createRelationship,
			updateRelationship,
		}),
		getEntitiesForRoom,
		getRelationships,
		createRelationship,
		updateRelationship,
	};
}

describe("applyAddressedTo (addressed-edge persistence)", () => {
	it("short-circuits to an empty result without any runtime interaction when there are no addressees", async () => {
		for (const addressedTo of [
			[],
			undefined,
		] as unknown as readonly string[][]) {
			const h = relationalRuntime();
			expect(
				await applyAddressedTo({
					runtime: h.runtime,
					message: makeMessage(),
					addressedTo,
				}),
			).toEqual({ created: 0, updated: 0, resolved: [] });
			expect(h.getEntitiesForRoom).not.toHaveBeenCalled();
			expect(h.getRelationships).not.toHaveBeenCalled();
			expect(h.createRelationship).not.toHaveBeenCalled();
			expect(h.updateRelationship).not.toHaveBeenCalled();
		}
	});

	it("returns an empty result without resolving anything when the message has no speaker", async () => {
		const h = relationalRuntime();
		const message = { ...makeMessage(), entityId: undefined } as Memory;
		expect(
			await applyAddressedTo({
				runtime: h.runtime,
				message,
				addressedTo: ["Alice"],
			}),
		).toEqual({ created: 0, updated: 0, resolved: [] });
		expect(h.getEntitiesForRoom).not.toHaveBeenCalled();
		expect(h.createRelationship).not.toHaveBeenCalled();
	});

	it("creates one addressed edge per resolved other participant with canonical tags and source metadata", async () => {
		const h = relationalRuntime();
		const result = await applyAddressedTo({
			runtime: h.runtime,
			message: makeMessage(),
			addressedTo: ["@alice"],
		});
		expect(result).toEqual({ created: 1, updated: 0, resolved: [HUMAN_X] });
		expect(h.createRelationship).toHaveBeenCalledTimes(1);
		const edge = vi.mocked(h.createRelationship).mock.calls[0][0];
		expect(edge.sourceEntityId).toBe(SENDER_ID);
		expect(edge.targetEntityId).toBe(HUMAN_X);
		expect(edge.tags).toEqual(["addressed", "addressed:auto"]);
		expect(edge.metadata?.source).toBe("message_handler_addressedTo");
		expect(
			Number.isNaN(
				new Date(edge.metadata?.lastInteractionAt as string).getTime(),
			),
		).toBe(false);
		expect(h.updateRelationship).not.toHaveBeenCalled();
	});

	it("updates the existing edge instead of duplicating it: dedupes tags, keeps foreign metadata, stamps source", async () => {
		const existing: Relationship = {
			id: "00000000-0000-0000-0000-00000000ff01" as UUID,
			sourceEntityId: SENDER_ID,
			targetEntityId: OTHER_BOT,
			agentId: AGENT_ID,
			tags: ["addressed", "custom-tag"],
			metadata: { custom: "keep" },
		};
		const h = relationalRuntime(ROOM_ROSTER, [existing]);
		const result = await applyAddressedTo({
			runtime: h.runtime,
			message: makeMessage(),
			addressedTo: ["SomeOtherBot"],
		});
		expect(result).toEqual({ created: 0, updated: 1, resolved: [OTHER_BOT] });
		expect(h.getRelationships).toHaveBeenCalledWith({
			entityIds: [SENDER_ID],
			tags: ["addressed"],
		});
		expect(h.createRelationship).not.toHaveBeenCalled();
		expect(h.updateRelationship).toHaveBeenCalledTimes(1);
		const updatedEdge = vi.mocked(h.updateRelationship).mock.calls[0][0];
		expect(updatedEdge.id).toBe(existing.id);
		expect(updatedEdge.tags).toEqual([
			"addressed",
			"custom-tag",
			"addressed:auto",
		]);
		expect(updatedEdge.metadata?.custom).toBe("keep");
		expect(updatedEdge.metadata?.source).toBe("message_handler_addressedTo");
	});

	it("never writes an edge for a tag resolving to the SPEAKER themself", async () => {
		const h = relationalRuntime();
		const result = await applyAddressedTo({
			runtime: h.runtime,
			message: makeMessage(),
			addressedTo: ["nubs"],
		});
		expect(result).toEqual({ created: 0, updated: 0, resolved: [] });
		expect(h.getRelationships).not.toHaveBeenCalled();
		expect(h.createRelationship).not.toHaveBeenCalled();
		expect(h.updateRelationship).not.toHaveBeenCalled();
	});

	it("persists UUID addressees without consulting the room entity list", async () => {
		const h = relationalRuntime([]);
		vi.mocked(h.getEntitiesForRoom).mockImplementation(async () => {
			throw new Error("room must not be read for pure-UUID tags");
		});
		const result = await applyAddressedTo({
			runtime: h.runtime,
			message: makeMessage(),
			addressedTo: [HUMAN_X],
		});
		expect(result).toEqual({ created: 1, updated: 0, resolved: [HUMAN_X] });
		expect(
			vi.mocked(h.createRelationship).mock.calls[0][0].targetEntityId,
		).toBe(HUMAN_X);
	});

	it("collapses repeated spellings of the same participant into a single edge", async () => {
		const h = relationalRuntime();
		const result = await applyAddressedTo({
			runtime: h.runtime,
			message: makeMessage(),
			addressedTo: ["Alice", "@alice", "ALICE"],
		});
		expect(result.created).toBe(1);
		expect(result.resolved).toEqual([HUMAN_X]);
		expect(h.createRelationship).toHaveBeenCalledTimes(1);
	});
});

describe("resolveAddressedTargets (name/id resolution)", () => {
	it("drops blank entries and non-string junk without any room lookup", async () => {
		const h = relationalRuntime();
		expect(
			await resolveAddressedTargets({
				runtime: h.runtime,
				message: makeMessage(),
				addressedTo: ["", "   ", 42 as unknown as string],
			}),
		).toEqual([]);
		expect(h.getEntitiesForRoom).not.toHaveBeenCalled();
	});

	it("keeps uppercase UUIDs verbatim and drops uuid-shaped invalid strings as unresolvable names", async () => {
		const h = relationalRuntime();
		const upper = HUMAN_X.toUpperCase();
		expect(
			await resolveAddressedTargets({
				runtime: h.runtime,
				message: makeMessage(),
				addressedTo: [upper, "00000000-0000-0000-0000-not-valid-uuid"],
			}),
		).toEqual([upper]);
	});

	it("strips @ and matches participant names case-insensitively against the room roster", async () => {
		const h = relationalRuntime();
		expect(
			await resolveAddressedTargets({
				runtime: h.runtime,
				message: makeMessage(),
				addressedTo: ["@ALICE"],
			}),
		).toEqual([HUMAN_X]);
	});

	it("maps the agent's own character.name to agentId even when absent from the room roster", async () => {
		const h = relationalRuntime([
			{ id: HUMAN_X, agentId: AGENT_ID, names: ["Alice"] },
		]);
		expect(
			await resolveAddressedTargets({
				runtime: h.runtime,
				message: makeMessage(),
				addressedTo: ["MyAgent"],
			}),
		).toEqual([AGENT_ID]);
	});

	it("skips participants without ids and non-string/empty alias entries", async () => {
		const h = relationalRuntime([
			{ agentId: AGENT_ID, names: ["Ghost"] },
			{ id: HUMAN_X, agentId: AGENT_ID, names: [123, "", "Alice"] },
		] as unknown as Entity[]);
		expect(
			await resolveAddressedTargets({
				runtime: h.runtime,
				message: makeMessage(),
				addressedTo: ["ghost", "Alice"],
			}),
		).toEqual([HUMAN_X]);
	});

	it("deduplicates an id tag and its name spelling into one resolution", async () => {
		const h = relationalRuntime();
		expect(
			await resolveAddressedTargets({
				runtime: h.runtime,
				message: makeMessage(),
				addressedTo: [OTHER_BOT, "@someotherbot"],
			}),
		).toEqual([OTHER_BOT]);
	});
});

describe("messageAddressedToOtherParticipant — added edge coverage", () => {
	it("treats the agent's character.username as self", async () => {
		const runtime = makeRuntime({
			character: { name: "Totally Unrelated", username: "selfhandle" },
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, agentId: AGENT_ID, names: ["selfhandle"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage(undefined, undefined, "selfhandle you around?"),
				addressedTo: ["@selfhandle"],
			}),
		).toBe(false);
	});

	it("never corroborates through a one-character name but does through a two-character one", async () => {
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: HUMAN_X, agentId: AGENT_ID, names: ["Q"] },
				{ id: OTHER_BOT, agentId: AGENT_ID, names: ["QQ"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage(undefined, undefined, "Q status report"),
				addressedTo: ["Q"],
			}),
		).toBe(false);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage(undefined, undefined, "QQ status report"),
				addressedTo: ["QQ"],
			}),
		).toBe(true);
	});

	it("escapes regex metacharacters in participant names", async () => {
		const runtime = makeRuntime({
			getEntitiesForRoom: vi.fn(async () => [
				{ id: HUMAN_X, agentId: AGENT_ID, names: ["Eliza.Bot"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage(
					undefined,
					undefined,
					"hey ElizaXBot are you there",
				),
				addressedTo: ["Eliza.Bot"],
			}),
		).toBe(false);
		expect(
			await messageAddressedToOtherParticipant({
				runtime,
				message: makeMessage(undefined, undefined, "Eliza.Bot status?"),
				addressedTo: ["Eliza.Bot"],
			}),
		).toBe(true);
	});

	it("filters non-string entries out of the tag list instead of crashing", async () => {
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(undefined, undefined, "Alice do the thing"),
				addressedTo: [null, "Alice"] as unknown as readonly string[],
			}),
		).toBe(true);
		expect(
			await messageAddressedToOtherParticipant({
				runtime: makeRuntime(roomWithOthers()),
				message: makeMessage(),
				addressedTo: [42] as unknown as readonly string[],
			}),
		).toBe(false);
	});
});

describe("messageVocativelyAddressesOtherParticipant — added edge coverage", () => {
	const nubilio = (): IAgentRuntime =>
		makeRuntime({
			character: { name: "remilio nubilio" },
			getEntitiesForRoom: vi.fn(async () => [
				{ id: AGENT_ID, agentId: AGENT_ID, names: ["remilio nubilio"] },
				{ id: OTHER_BOT, agentId: AGENT_ID, names: ["Eliza"] },
				{ id: SENDER_ID, agentId: AGENT_ID, names: ["nubs"] },
			]),
		} as unknown as Partial<IAgentRuntime>);

	it('gates further greeting forms ("yo eliza …", "gm @eliza!")', async () => {
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(
					undefined,
					undefined,
					"yo eliza can you take this",
				),
			}),
		).toBe(true);
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime: nubilio(),
				message: makeMessage(undefined, undefined, "gm @eliza!"),
			}),
		).toBe(true);
	});

	it("skips a participant whose only name equals one token of OUR multi-word name", async () => {
		const runtime = makeRuntime({
			character: { name: "remilio nubilio" },
			getEntitiesForRoom: vi.fn(async () => [
				{ id: OTHER_BOT, agentId: AGENT_ID, names: ["remilio"] },
			]),
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime,
				message: makeMessage(undefined, undefined, "remilio you around?"),
			}),
		).toBe(false);
	});

	it("returns false for whitespace-only text without reading the room", async () => {
		const getEntitiesForRoom = vi.fn(async () => {
			throw new Error("whitespace-only text must exit before room reads");
		});
		const runtime = makeRuntime({
			getEntitiesForRoom,
		} as unknown as Partial<IAgentRuntime>);
		expect(
			await messageVocativelyAddressesOtherParticipant({
				runtime,
				message: makeMessage(undefined, undefined, "  \n\t "),
			}),
		).toBe(false);
		expect(getEntitiesForRoom).not.toHaveBeenCalled();
	});
});
