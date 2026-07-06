/**
 * Unit tests for `factsProvider` (advanced-capabilities): asserts BM25 keyword
 * retrieval surfaces the relevant durable/current facts (including a direct-recall
 * fallback and current-fact time weighting), that rendering attributes facts by
 * provenance (speaker vs neutral room header) while room-fact recall stays
 * intact for bot/bridge senders — relays carry real human questions — and that
 * the provider never requests embeddings. Uses a hand-built deterministic
 * runtime mock — no live model, no DB — whose `useModel` throws to enforce the
 * no-embeddings invariant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { factsProvider } from "./facts.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;
const otherEntityId = "00000000-0000-0000-0000-0000000000dd" as UUID;

function memory(
	id: string,
	text: string,
	metadata: Record<string, unknown> = {},
	createdAt = Date.now(),
	factEntityId: UUID = entityId,
): Memory {
	return {
		id: id as UUID,
		entityId: factEntityId,
		agentId,
		roomId,
		content: { text },
		metadata,
		createdAt,
	};
}

function makeRuntime(args: {
	facts?: Memory[];
	roomFacts?: Memory[];
	entityFacts?: Memory[];
	recentMessages?: Memory[];
}): IAgentRuntime & {
	getMemories: ReturnType<typeof vi.fn>;
	useModel: ReturnType<typeof vi.fn>;
} {
	const runtime = {
		agentId,
		character: { name: "Eliza", bio: "", system: "" },
		getService: vi.fn(() => null),
		getMemories: vi.fn(
			async (params: { tableName: string; roomId?: UUID; entityId?: UUID }) => {
				if (params.tableName === "messages") {
					return args.recentMessages ?? [];
				}
				if (params.tableName === "facts") {
					if (params.roomId) {
						return args.roomFacts ?? args.facts ?? [];
					}
					if (params.entityId) {
						return args.entityFacts ?? args.facts ?? [];
					}
					return args.facts ?? [];
				}
				return [];
			},
		),
		useModel: vi.fn(async () => {
			throw new Error("FACTS provider must not request embeddings");
		}),
	};
	return runtime as unknown as IAgentRuntime & {
		getMemories: ReturnType<typeof vi.fn>;
		useModel: ReturnType<typeof vi.fn>;
	};
}

describe("factsProvider keyword retrieval", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retrieves matching facts with BM25 keywords without calling embeddings", async () => {
		const runtime = makeRuntime({
			recentMessages: [memory("msg-1", "Berlin keeps coming up today")],
			facts: [
				memory("fact-1", "the user lives in Berlin", {
					kind: "durable",
					category: "identity",
					confidence: 0.9,
					keywords: ["berlin", "lives"],
				}),
				memory("fact-2", "the user likes Tokyo hotels", {
					kind: "durable",
					category: "preference",
					confidence: 0.9,
					keywords: ["tokyo", "hotels"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "Do you remember anything about Berlin?", {
				source: "test",
			}),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ tableName: "facts", count: 120 }),
		);
		const sections = result.text.split("\n\n");
		const knowledgeSection = sections.find((section) =>
			section.startsWith("Things Eliza knows about"),
		);
		expect(knowledgeSection).toContain("the user lives in Berlin");
		// The stored preference is NOT BM25-relevant to this turn, so it stays
		// out of the ranked knowledge section — it surfaces only through the
		// bounded standing-preferences lane, where the model judges relevance.
		expect(knowledgeSection).not.toContain("Tokyo hotels");
		const preferenceSection = sections.find((section) =>
			section.startsWith("Standing preferences"),
		);
		expect(preferenceSection).toContain("Tokyo hotels");
	});

	it("uses stored keywords even when the exact query word is not in fact text", async () => {
		const runtime = makeRuntime({
			facts: [
				memory("fact-1", "the user prefers aisle seats", {
					kind: "durable",
					category: "preference",
					confidence: 0.8,
					keywords: ["flight", "seat", "aisle"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "Book the flight with my seat preference"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("the user prefers aisle seats");
	});

	it("always surfaces the sender's top preference facts in a bounded lane, even with zero lexical overlap", async () => {
		const launchFacts = Array.from({ length: 6 }, (_, index) =>
			memory(`fact-launch-${index}`, `launch planning detail ${index}`, {
				kind: "durable",
				category: "business_role",
				confidence: 0.8,
				keywords: ["launch", "planning", `detail-${index}`],
			}),
		);
		const runtime = makeRuntime({
			facts: [
				...launchFacts,
				// The MVP bug (#14693): a reply-style preference that lexically
				// matches almost no turn must still reach the prompt every turn.
				memory("fact-style", "the user hates long replies", {
					kind: "durable",
					category: "preference",
					confidence: 0.95,
					keywords: ["brief", "replies"],
				}),
				memory("fact-domain", "the user likes Tokyo hotels", {
					kind: "durable",
					category: "preference",
					confidence: 1,
					keywords: ["tokyo", "hotels"],
				}),
				memory("fact-timing", "the user prefers morning check-ins", {
					kind: "durable",
					category: "preference",
					confidence: 0.7,
					keywords: ["morning", "check-ins"],
				}),
				// Lowest prior — must be evicted by the lane bound of 3.
				memory("fact-overflow", "the user prefers metric units", {
					kind: "durable",
					category: "preference",
					confidence: 0.6,
					keywords: ["metric", "units"],
				}),
				// Another participant's preference must never enter the sender lane.
				memory(
					"fact-other",
					"Bob prefers voice notes",
					{
						kind: "durable",
						category: "preference",
						confidence: 1,
						keywords: ["voice", "notes"],
					},
					Date.now(),
					otherEntityId,
				),
			],
		});

		const message = memory("msg-current", "What changed for launch planning?");
		message.content.senderName = "Alice";
		const result = await factsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		const durableFacts = result.data.durableFacts as Memory[];
		const durableIds = durableFacts.map((fact) => fact.id);
		// Lane = top-3 sender preferences by prior, merged ahead of the ranked
		// pool: 6 ranked launch facts + 3 lane rows.
		expect(durableIds).toContain("fact-style");
		expect(durableIds).toContain("fact-domain");
		expect(durableIds).toContain("fact-timing");
		expect(durableIds).not.toContain("fact-overflow");
		expect(durableIds).not.toContain("fact-other");
		expect(durableFacts).toHaveLength(9);

		const sections = result.text.split("\n\n");
		const preferenceSection = sections.find((section) =>
			section.startsWith(
				"Standing preferences Alice has expressed (apply any that are relevant to this reply):",
			),
		);
		expect(preferenceSection).toBeDefined();
		expect(preferenceSection).toContain("the user hates long replies");
		expect(preferenceSection).toContain("the user likes Tokyo hotels");
		expect(preferenceSection).toContain("the user prefers morning check-ins");
		expect(preferenceSection).not.toContain("Bob prefers voice notes");
		// Lane rows render once — in the preferences section, not duplicated
		// under the general knowledge header.
		const knowledgeSection = sections.find((section) =>
			section.startsWith("Things Eliza knows about Alice:"),
		);
		expect(knowledgeSection).toContain("launch planning detail");
		expect(knowledgeSection).not.toContain("hates long replies");
	});

	it("surfaces a durable fact on direct recall even when keywords do not BM25-match", async () => {
		// Live regression on 2026-05-28 (tj-8e3d5c79321002): user stored
		// "my car's name is Bertha" then later asked "whats my cars name?".
		// BM25 scored 0 (no stemming for cars->car, and the only shared term
		// "name" had ~0 IDF across the small fact pool), so the durable fact
		// was filtered out and the bot answered "I don't have any info about a
		// car name for you." Durable identity facts are few and high-value;
		// when relevance ranking surfaces none, fall back to recent durable
		// facts so direct recall works.
		const runtime = makeRuntime({
			facts: [
				memory("fact-1", "my car's name is Bertha, a 1998 Civic", {
					kind: "durable",
					category: "identity",
					confidence: 0.9,
					keywords: ["car", "name", "bertha", "civic"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "whats my cars name?"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("Bertha");
		expect(result.text).not.toContain("No facts available");
	});

	it("applies current-fact time weighting after keyword relevance", async () => {
		// bun's vitest compat layer doesn't implement vi.useFakeTimers /
		// vi.setSystemTime, so pin Date.now() directly. This is the only
		// timestamp facts.ts reads when ranking current facts.
		const fixedNow = Date.parse("2026-05-11T12:00:00.000Z");
		const _nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		const runtime = makeRuntime({
			facts: [
				memory(
					"fact-old",
					"the user is anxious about launch",
					{
						kind: "current",
						category: "feeling",
						confidence: 0.9,
						keywords: ["anxious", "launch"],
						validAt: "2026-03-01T12:00:00.000Z",
					},
					Date.parse("2026-03-01T12:00:00.000Z"),
				),
				memory(
					"fact-new",
					"the user is anxious about launch today",
					{
						kind: "current",
						category: "feeling",
						confidence: 0.7,
						keywords: ["anxious", "launch"],
						validAt: "2026-05-11T09:00:00.000Z",
					},
					Date.parse("2026-05-11T09:00:00.000Z"),
				),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "I am still anxious about launch"),
			{ values: {}, data: {}, text: "" },
		);

		const currentFacts = result.data.currentFacts as Memory[];
		expect(currentFacts.map((fact) => fact.id)).toEqual([
			"fact-new",
			"fact-old",
		]);
	});
});

describe("factsProvider provenance attribution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const roomFactAboutSomeoneElse = memory(
		"fact-room-1",
		"nubs created the remilio project last spring",
		{
			kind: "durable",
			category: "identity",
			confidence: 0.9,
			keywords: ["nubs", "remilio", "project"],
		},
		Date.now(),
		otherEntityId,
	);

	it("renders room-pool facts about other entities under the neutral room header, not as speaker facts", async () => {
		const runtime = makeRuntime({
			roomFacts: [roomFactAboutSomeoneElse],
			entityFacts: [],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "who created the remilio project?", {
				source: "discord",
			}),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("nubs created the remilio project");
		expect(result.text).toContain("Known facts in this room");
		// The room fact is about otherEntityId — it must NOT be attributed to
		// the current speaker.
		expect(result.text).not.toContain("knows about");
	});

	it("keeps the speaker header for facts stored against the sender's own entity", async () => {
		const senderFact = memory("fact-sender-1", "the user lives in Berlin", {
			kind: "durable",
			category: "identity",
			confidence: 0.9,
			keywords: ["berlin", "lives"],
		});
		const runtime = makeRuntime({
			roomFacts: [senderFact],
			entityFacts: [senderFact],
		});

		const message = memory("msg-current", "anything about Berlin?");
		message.content.senderName = "Alice";
		const result = await factsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toContain("Things Eliza knows about Alice:");
		expect(result.text).toContain("the user lives in Berlin");
		expect(result.text).not.toContain("Known facts in this room");
	});

	it("keeps room facts recallable for connector-stamped bot/webhook senders, under the neutral header", async () => {
		// Relays carry real human questions (the ZenithProxy pattern): a human
		// asks through the bridge, so the room pool must stay recallable on the
		// bot-stamped turn — only the attribution changes.
		const botRuntime = makeRuntime({
			roomFacts: [roomFactAboutSomeoneElse],
			entityFacts: [],
		});
		const botMessage = memory(
			"msg-bot",
			"who created the remilio project?",
			{},
			Date.now(),
		);
		botMessage.content.metadata = { fromBot: true };
		botMessage.content.senderName = "2fingersBTW | ZenithProxy";
		const botResult = await factsProvider.get(botRuntime, botMessage, {
			values: {},
			data: {},
			text: "",
		});

		// The room-scoped fetch still happens on the bot turn.
		const botFactCalls = botRuntime.getMemories.mock.calls.filter(
			([params]: [{ tableName: string; roomId?: UUID }]) =>
				params.tableName === "facts" && params.roomId,
		);
		expect(botFactCalls.length).toBe(1);

		// Recall preserved; the room fact is never attributed to the bridge bot.
		expect(botResult.text).toContain("nubs created the remilio project");
		expect(botResult.text).toContain("Known facts in this room");
		expect(botResult.text).not.toContain("knows about");
	});

	it("keeps both the sender's own facts and room facts for internal bridge sources", async () => {
		const bridgeOwnFact = memory(
			"fact-bridge-1",
			"the relay mirrors the minecraft server chat",
			{
				kind: "durable",
				category: "identity",
				confidence: 0.9,
				keywords: ["relay", "minecraft", "chat"],
			},
		);
		const runtime = makeRuntime({
			roomFacts: [roomFactAboutSomeoneElse],
			entityFacts: [bridgeOwnFact],
		});
		const message = memory(
			"msg-bridge",
			"who created the remilio project the relay mirrors?",
		);
		message.content.source = "acpx:sub-agent-router";
		const result = await factsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		// Sender-cluster facts keep the speaker header; room facts about other
		// participants stay recallable under the neutral header.
		expect(result.text).toContain("mirrors the minecraft server chat");
		expect(result.text).toContain("nubs created the remilio project");
		expect(result.text).toContain("Known facts in this room");
	});
});
