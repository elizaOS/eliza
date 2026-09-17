import { describe, expect, it } from "vitest";
import { completionContextSources } from "../../runtime/completion-context";
import type { ContextObject } from "../../types/context-object";
import type { Memory } from "../../types/memory";
import type { HistoryDiscovery } from "./history-discovery";
import { createSourceReplySnapshot, resolveSourceReply } from "./source-reply";
import {
	getStage1RoutingRepair,
	getStage1UnusableDecisionRepair,
} from "./stage1-generation";

function fixture() {
	const memory = {
		id: "source",
		roomId: "room",
		entityId: "user",
		agentId: "agent",
		content: { text: "  Mira’s bag is orange.\nKeep  two spaces.\n" },
	} as Memory;
	const context: ContextObject = {
		id: "turn",
		metadata: { roomId: "room", messageId: "turn" },
		staticPrefix: { systemPrompt: { content: "Eliza", stable: true } },
		events: [
			{
				id: "history:source",
				type: "segment",
				source: "prior-dialogue",
				segment: {
					id: "history:source",
					label: "prior_message:user",
					content: `Nubs: ${memory.content.text?.trim()}`,
					stable: false,
					metadata: { roomId: "room", entityId: "user", speakerName: "Nubs" },
				},
			},
		],
	};
	const sourceSetId = completionContextSources(context).sourceSetId;
	const projection: HistoryDiscovery = {
		sourceSetId,
		scope: {
			agentId: "agent",
			roomId: "room",
			entityId: "user",
			roles: ["OWNER"],
		},
		visibleEventIds: new Set(),
		loadedSourceIds: new Set(["h1"]),
	};
	const snapshot = createSourceReplySnapshot(context, projection, [memory]);
	if (!snapshot) throw new Error("missing snapshot");
	const raw = {
		shouldRespond: "RESPOND",
		contexts: ["simple"],
		intents: [],
		candidateActionNames: [],
		contextRequests: [],
		replyEffectStatus: "none",
		replyText: [
			{ kind: "text", value: "You said:\n" },
			{ kind: "source", value: "h1" },
		],
		completionContext: {
			mode: "relevant_prior_dialogue",
			complete: true,
			sourceSetId,
			relevantSourceIds: ["h1"],
			constraintSourceIds: [],
			referentSourceIds: [],
			pendingIntentSourceIds: [],
		},
	};
	return { memory, context, projection, snapshot, raw };
}
describe("source-backed native replies", () => {
	it("preserves original bytes, raw model output and current routing guards", () => {
		const { memory, context, snapshot, raw } = fixture();
		const before = JSON.stringify({ context, raw });
		const r = resolveSourceReply(context, snapshot, raw);
		expect(r?.replyText).toBe(`You said:\n\n\n${memory.content.text}\n\n`);
		expect(JSON.stringify({ context, raw })).toBe(before);
		expect(getStage1UnusableDecisionRepair(r ?? null)).toBeUndefined();
		expect(
			getStage1RoutingRepair({ ...r, intents: ["Create a note"] }),
		).toBeDefined();
		memory.content.text = "later mutation";
		expect(resolveSourceReply(context, snapshot, raw)?.replyText).not.toContain(
			"later mutation",
		);
	});
	it.each(["turn", "source", "speaker", "room"])(
		"rejects stale %s binding",
		(mode) => {
			const { context, snapshot, raw } = fixture();
			if (mode === "turn") context.id = "changed";
			else if (mode === "room") context.metadata = { roomId: "other" };
			else {
				const e = context.events[0];
				if (e.type !== "segment") throw Error();
				if (mode === "source") e.segment.content += "changed";
				else e.segment.metadata = { entityId: "other" };
			}
			expect(resolveSourceReply(context, snapshot, raw)).toBeUndefined();
		},
	);
	it.each(["agent", "owner", "room", "body", "duplicate", "envelope"])(
		"does not resolve unmatched %s records",
		(mode) => {
			const f = fixture();
			const m = structuredClone(f.memory);
			if (mode === "agent") m.agentId = "other" as Memory["agentId"];
			if (mode === "owner") m.entityId = "other" as Memory["entityId"];
			if (mode === "room") m.roomId = "other" as Memory["roomId"];
			if (mode === "body") m.content.text = "different";
			if (mode === "envelope")
				m.content.text += "\n[language instruction: Reply in English]";
			const s = createSourceReplySnapshot(
				f.context,
				f.projection,
				mode === "duplicate" ? [m, m] : [m],
			);
			expect(s?.originals.size).toBe(0);
			if (!s) throw Error();
			expect(() => resolveSourceReply(f.context, s, f.raw)).toThrow();
		},
	);
	it("keeps unavailable selections in history recovery", () => {
		const f = fixture();
		expect(
			resolveSourceReply(
				f.context,
				{ ...f.snapshot, suppliedIds: new Set() },
				f.raw,
			),
		).toBeUndefined();
	});
	it.each([
		null,
		"old string",
		[{ kind: "source", value: "h99" }],
		[{ kind: "text", value: 1 }],
		[{ kind: "source", value: "h1", extra: true }],
		[{ kind: "other", value: "h1" }],
	])("rejects malformed parts %j", (parts) => {
		const f = fixture();
		expect(() =>
			resolveSourceReply(f.context, f.snapshot, { ...f.raw, replyText: parts }),
		).toThrow();
	});
	it("allows no-reply and ordinary text without interpreting source-looking markers", () => {
		const f = fixture();
		expect(
			resolveSourceReply(f.context, f.snapshot, { ...f.raw, replyText: [] })
				?.replyText,
		).toBe("");
		expect(
			resolveSourceReply(f.context, f.snapshot, {
				...f.raw,
				replyText: [{ kind: "text", value: "[source:h1]" }],
			})?.replyText,
		).toBe("[source:h1]");
	});
	it("does not strip a literal speaker prefix", () => {
		const f = fixture();
		f.memory.content.text = "Nubs: This prefix is part of my message.";
		const e = f.context.events[0];
		if (e.type !== "segment") throw Error();
		e.segment.content = f.memory.content.text;
		f.projection.sourceSetId = completionContextSources(f.context).sourceSetId;
		f.raw.completionContext.sourceSetId = f.projection.sourceSetId;
		const s = createSourceReplySnapshot(f.context, f.projection, [f.memory]);
		if (!s) throw Error();
		expect(resolveSourceReply(f.context, s, f.raw)?.replyText).toBe(
			"You said:\n\n\nNubs: This prefix is part of my message.\n\n",
		);
	});
});
