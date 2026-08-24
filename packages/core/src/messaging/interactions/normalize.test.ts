/**
 * Unit tests for the outbound interaction normalizer. These exercise the real
 * parse/strip pipeline (`parseInteractionBlocks`,
 * `stripUnclaimedInteractionMarkup`) through `normalizeContentInteractions`
 * and `stripInteractionMarkers`, using wire markers produced by the real
 * serializer, the way producers and connectors use them.
 */

import { describe, expect, it } from "vitest";
import type {
	ChoiceInteraction,
	FollowupsInteraction,
	TaskInteraction,
} from "../../types/interactions.js";
import type { Content } from "../../types/primitives.js";
import {
	normalizeContentInteractions,
	stripInteractionMarkers,
} from "./normalize.js";
import { serializeInteractionBlock } from "./serialize.js";

describe("messaging interactions normalize", () => {
	it("returns the identical content object when text is missing, empty, or not parseable input", () => {
		const emptyText: Content = { text: "" };
		expect(normalizeContentInteractions(emptyText)).toBe(emptyText);

		const noText: Content = {};
		expect(normalizeContentInteractions(noText)).toBe(noText);
	});

	it("returns the identical content object for plain prose without markers", () => {
		const content: Content = { text: "Just a plain sentence, nothing else." };
		expect(normalizeContentInteractions(content)).toBe(content);
	});

	it("keeps the identical object when interactions are already attached and text needs no cleanup", () => {
		const task: TaskInteraction = {
			kind: "task",
			threadId: "t-1",
			title: "Running build",
		};
		const content: Content = {
			text: "Status update below.",
			interactions: [task],
		};
		expect(normalizeContentInteractions(content)).toBe(content);
	});

	it("parses a serialized form block into typed interactions and strips the marker from text", () => {
		const form = {
			kind: "form" as const,
			id: "form-77",
			title: "User Profile",
			submitLabel: "Save",
			fields: [{ name: "name", label: "Full Name", type: "text" as const }],
		};
		const serialized = serializeInteractionBlock(form);
		const content: Content = {
			text: `Please fill this in.\n${serialized}\nThank you.`,
		};

		const normalized = normalizeContentInteractions(content);

		expect(normalized).not.toBe(content);
		expect(normalized.interactions).toHaveLength(1);
		const block = normalized.interactions?.[0];
		expect(block?.kind).toBe("form");
		if (block?.kind === "form") {
			expect(block.id).toBe("form-77");
			expect(block.title).toBe("User Profile");
			expect(block.submitLabel).toBe("Save");
			expect(block.fields).toEqual([
				{ name: "name", label: "Full Name", type: "text" },
			]);
		}
		// Claimed markup is non-destructive: text is left untouched so the
		// dashboard segment renderer can still interleave it.
		expect(normalized.text).toBe(content.text);
	});

	it("round-trips a serialized choice block with scope, id, and options intact", () => {
		const choice: ChoiceInteraction = {
			kind: "choice",
			id: "choice-9",
			scope: "global",
			allowCustom: true,
			options: [
				{ label: "Option A", value: "opt_a" },
				{ label: "Option B", value: "opt_b" },
			],
		};
		const content: Content = {
			text: `Pick one:\n${serializeInteractionBlock(choice)}`,
		};

		const normalized = normalizeContentInteractions(content);

		expect(normalized.interactions).toHaveLength(1);
		const block = normalized.interactions?.[0];
		expect(block?.kind).toBe("choice");
		if (block?.kind === "choice") {
			expect(block.id).toBe("choice-9");
			expect(block.scope).toBe("global");
			expect(block.allowCustom).toBe(true);
			expect(block.options).toEqual([
				{ label: "Option A", value: "opt_a" },
				{ label: "Option B", value: "opt_b" },
			]);
		}
		expect(normalized.text).toBe(content.text);
	});

	it("round-trips followups chips with kinds and payloads intact", () => {
		const followups: FollowupsInteraction = {
			kind: "followups",
			id: "fu-3",
			options: [
				{ kind: "reply", payload: "yes please", label: "Yes" },
				{ kind: "navigate", payload: "/settings", label: "Settings" },
			],
		};
		const content: Content = {
			text: `${serializeInteractionBlock(followups)}`,
		};

		const normalized = normalizeContentInteractions(content);

		expect(normalized.interactions).toEqual([followups]);
		// The claimed block stays in text; only unclaimed machinery is removed.
		expect(normalized.text).toBe(content.text);
	});

	it("parses a hand-written task marker into a task card and leaves prose untouched", () => {
		const content: Content = {
			text: "Deploy started.\n[TASK:abcd1234-5678-4daf-9c0f-112233445566]Deploy the service[/TASK]",
		};

		const normalized = normalizeContentInteractions(content);

		expect(normalized.interactions).toEqual([
			{
				kind: "task",
				threadId: "abcd1234-5678-4daf-9c0f-112233445566",
				title: "Deploy the service",
			},
		]);
		expect(normalized.text).toBe(content.text);
	});

	it("parses multiple blocks in document order from one message", () => {
		const choice: ChoiceInteraction = {
			kind: "choice",
			id: "c-multi",
			scope: "global",
			options: [{ label: "Go", value: "go" }],
		};
		const content: Content = {
			text: `[TASK:abcd1234-5678-4daf-9c0f-112233445566]Long deploy[/TASK]\n${serializeInteractionBlock(choice)}`,
		};

		const normalized = normalizeContentInteractions(content);

		expect(normalized.interactions?.map((block) => block.kind)).toEqual([
			"task",
			"choice",
		]);
	});

	it("rewrites text once when interactions are attached and terminal unclaimed markup is present", () => {
		const task: TaskInteraction = {
			kind: "task",
			threadId: "t-2",
			title: "Queued",
		};
		const content: Content = {
			text: "Answer below.\n[CHOICE:global]\nalpha=First\nbeta=Second",
			interactions: [task],
		};

		const normalized = normalizeContentInteractions(content);

		expect(normalized).not.toBe(content);
		expect(normalized.text).toBe("Answer below.");
		// Existing typed interactions are preserved untouched.
		expect(normalized.interactions).toEqual([task]);
	});

	it("strips terminal unclaimed choice markup even when nothing parses into blocks", () => {
		const content: Content = {
			text: "Here is your answer.\n[CHOICE:global]\nalpha=First\nbeta=Second",
		};

		const normalized = normalizeContentInteractions(content);

		expect(normalized).not.toBe(content);
		expect(normalized.text).toBe("Here is your answer.");
		expect(normalized.interactions).toBeUndefined();
	});

	it("is idempotent: normalizing an already-normalized message is a no-op reference", () => {
		const choice: ChoiceInteraction = {
			kind: "choice",
			id: "c-idem",
			scope: "global",
			options: [{ label: "Stay", value: "stay" }],
		};
		const first = normalizeContentInteractions({
			text: `Hello there.\n${serializeInteractionBlock(choice)}`,
		});
		const second = normalizeContentInteractions(first);

		expect(second).toBe(first);
	});

	it("stripInteractionMarkers leaves only the prose for claimed blocks", () => {
		const form = {
			kind: "form" as const,
			id: "f-strip",
			fields: [{ name: "email", label: "Email", type: "text" as const }],
		};
		const text = `Intro line.\n${serializeInteractionBlock(form)}\nOutro line.`;

		expect(stripInteractionMarkers(text)).toBe("Intro line.\n\nOutro line.");
	});

	it("stripInteractionMarkers leaves plain prose unchanged", () => {
		const text = "No markers in here at all.";
		expect(stripInteractionMarkers(text)).toBe(text);
	});
});
