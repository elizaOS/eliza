/**
 * Verifies the bridge between message text and the typed Content.interactions
 * field: `stripInteractionMarkers` returns marker-free prose, and
 * `normalizeContentInteractions` parses valid markers into typed interaction
 * blocks while leaving human prose and already-normalized content untouched.
 */

import { describe, expect, it } from "vitest";
import type { ChoiceInteraction } from "../../types/interactions";
import type { Content } from "../../types/primitives";
import {
	normalizeContentInteractions,
	stripInteractionMarkers,
} from "./normalize";

const CHOICE_BLOCK = "[CHOICE:test]\na=Alpha\nb=Beta\n[/CHOICE]";

function content(overrides: Partial<Content> = {}): Content {
	return { text: "hello", ...overrides };
}

describe("stripInteractionMarkers", () => {
	it("removes a valid CHOICE block and keeps the surrounding prose", () => {
		const text = `Pick one:\n${CHOICE_BLOCK}`;
		expect(stripInteractionMarkers(text)).toBe("Pick one:");
	});

	it("removes a valid TASK marker and keeps prose", () => {
		const text =
			"Please do this: [TASK:12345678-1234-1234-1234-123456789abc]Fix the bug[/TASK]";
		expect(stripInteractionMarkers(text)).toBe("Please do this:");
	});

	it("leaves plain prose untouched", () => {
		expect(stripInteractionMarkers("Just a normal message.")).toBe(
			"Just a normal message.",
		);
	});

	it("removes markers from the middle of a sentence", () => {
		const text = `Before\n${CHOICE_BLOCK}\nAfter`;
		expect(stripInteractionMarkers(text)).toBe("Before\n\nAfter");
	});
});

describe("normalizeContentInteractions", () => {
	it("returns the same object when text is missing or empty", () => {
		const noText = content({ text: "" });
		expect(normalizeContentInteractions(noText)).toBe(noText);

		const missingText = { hello: "world" } as unknown as Content;
		expect(normalizeContentInteractions(missingText)).toBe(missingText);
	});

	it("returns the same object when no interaction markers are present", () => {
		const plain = content({ text: "No markers here." });
		expect(normalizeContentInteractions(plain)).toBe(plain);
	});

	it("parses a valid CHOICE block into typed interactions", () => {
		const original = `Pick one:\n${CHOICE_BLOCK}`;
		const result = normalizeContentInteractions(content({ text: original }));
		expect(Array.isArray(result.interactions)).toBe(true);
		expect(result.interactions).toHaveLength(1);
		const block = result.interactions?.[0] as ChoiceInteraction | undefined;
		expect(block?.kind).toBe("choice");
		expect(block?.scope).toBe("test");
		expect(block?.options).toEqual([
			{ value: "a", label: "Alpha" },
			{ value: "b", label: "Beta" },
		]);
		// Claimed markers stay in the text for the dashboard segment renderer;
		// only the typed interactions array is attached.
		expect(result.text).toBe(original);
	});

	it("parses a TASK marker into a task interaction", () => {
		const text =
			"Please: [TASK:12345678-1234-1234-1234-123456789abc]Fix the bug[/TASK]";
		const result = normalizeContentInteractions(content({ text }));
		expect(result.interactions).toHaveLength(1);
		const task = result.interactions?.[0] as
			| { kind: "task"; threadId: string }
			| undefined;
		expect(task?.kind).toBe("task");
		expect(task?.threadId).toBe("12345678-1234-1234-1234-123456789abc");
	});

	it("strips unclaimed terminal markup while preserving existing interactions", () => {
		// The trailing [CHOICE] block is unclaimed (no valid scope header), so
		// the unclaimed suffix is removed from text while the existing typed
		// interactions array is preserved untouched.
		const withInteractions = content({
			text: "Body\n[CHOICE]\na=Alpha\n[/CHOICE]",
			interactions: [{ kind: "task", threadId: "abc", title: "x" }],
		});
		const result = normalizeContentInteractions(withInteractions);
		expect(result.interactions).toHaveLength(1);
		expect(result.interactions?.[0]?.kind).toBe("task");
		expect(result.text).toBe("Body");
	});

	it("is idempotent for an already-normalized content", () => {
		const source = content({ text: `Pick one:\n${CHOICE_BLOCK}` });
		const once = normalizeContentInteractions(source);
		const twice = normalizeContentInteractions(once);
		expect(twice.interactions).toHaveLength(1);
		expect(twice.text).toBe(once.text);
		const onceChoice = once.interactions?.[0] as ChoiceInteraction | undefined;
		const twiceChoice = twice.interactions?.[0] as
			| ChoiceInteraction
			| undefined;
		expect(twiceChoice?.options).toEqual(onceChoice?.options);
	});

	it("leaves plain prose content identical even with empty interactions array", () => {
		const plain = content({ text: "hi", interactions: [] });
		expect(normalizeContentInteractions(plain)).toBe(plain);
	});
});
