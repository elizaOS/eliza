import { describe, expect, it } from "vitest";
import type {
	ChoiceInteraction,
	Content,
	FormInteraction,
	SecretInteraction,
} from "../../types";
import {
	decodeCallback,
	encodeReplyCallback,
	isInteractionCallback,
	MAX_CALLBACK_BYTES,
} from "./callback";
import { toNeutralLayout } from "./layout";
import {
	normalizeContentInteractions,
	stripInteractionMarkers,
} from "./normalize";
import {
	findInteractionRegions,
	hasInteractionBlocks,
	parseInteractionBlocks,
} from "./parse";
import { appendInteractionBlock, serializeInteractionBlock } from "./serialize";

describe("parse", () => {
	it("parses a choice block with scope and id", () => {
		const text =
			"Pick one:\n[CHOICE:approve id=abc]\nyes=Yes, ship it\nno=Cancel\n[/CHOICE]";
		const { blocks, cleanedText } = parseInteractionBlocks(text);
		expect(blocks).toHaveLength(1);
		const block = blocks[0] as ChoiceInteraction;
		expect(block.kind).toBe("choice");
		expect(block.scope).toBe("approve");
		expect(block.id).toBe("abc");
		expect(block.options).toEqual([
			{ value: "yes", label: "Yes, ship it" },
			{ value: "no", label: "Cancel" },
		]);
		expect(cleanedText).toBe("Pick one:");
	});

	it("parses the allow_custom flag and round-trips it", () => {
		const { blocks } = parseInteractionBlocks(
			"[CHOICE:approve id=abc allow_custom]\nyes=Yes\n[/CHOICE]",
		);
		expect((blocks[0] as ChoiceInteraction).allowCustom).toBe(true);
		const rt = parseInteractionBlocks(serializeInteractionBlock(blocks[0]));
		expect((rt.blocks[0] as ChoiceInteraction).allowCustom).toBe(true);
	});

	it("parses a form block from JSON and caps fields", () => {
		const fields = Array.from({ length: 25 }, (_, i) => ({
			name: `f${i}`,
			type: "text",
		}));
		const text = `[FORM]\n${JSON.stringify({ title: "Login", fields })}\n[/FORM]`;
		const { blocks } = parseInteractionBlocks(text);
		const form = blocks[0] as FormInteraction;
		expect(form.kind).toBe("form");
		expect(form.title).toBe("Login");
		expect(form.fields).toHaveLength(20);
		expect(form.submitLabel).toBe("Submit");
	});

	it("rejects malformed form JSON (left as text)", () => {
		const text = "[FORM]\n{not json}\n[/FORM]";
		const { blocks, cleanedText } = parseInteractionBlocks(text);
		expect(blocks).toHaveLength(0);
		expect(cleanedText).toContain("[FORM]");
	});

	it("parses a task block and validates the threadId shape", () => {
		const id = "abc12345-def6-7890-abcd-ef1234567890";
		const { blocks } = parseInteractionBlocks(
			`[TASK:${id}]Ship the thing[/TASK]`,
		);
		expect(blocks[0]).toMatchObject({
			kind: "task",
			threadId: id,
			title: "Ship the thing",
		});
		// prose-shaped id must not trigger a widget
		expect(hasInteractionBlocks("[TASK: do the thing]")).toBe(false);
	});

	it("parses followups with kinds, defaulting to reply", () => {
		const text =
			"[FOLLOWUPS id=f1]\nnavigate:/tasks=Open tasks\nprompt:Draft a reply=Draft\nyes=Yes\n[/FOLLOWUPS]";
		const { blocks } = parseInteractionBlocks(text);
		expect(blocks[0]).toMatchObject({
			kind: "followups",
			id: "f1",
			options: [
				{ kind: "navigate", payload: "/tasks", label: "Open tasks" },
				{ kind: "prompt", payload: "Draft a reply", label: "Draft" },
				{ kind: "reply", payload: "yes", label: "Yes" },
			],
		});
	});

	it("keeps multiple blocks in document order and strips them all", () => {
		const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const text = `Status:\n[TASK:${id}]Build[/TASK]\nWhat next?\n[CHOICE:next id=n1]\na=A\nb=B\n[/CHOICE]`;
		const { blocks, cleanedText } = parseInteractionBlocks(text);
		expect(blocks.map((b) => b.kind)).toEqual(["task", "choice"]);
		// a removed block between two lines collapses to a paragraph break
		expect(cleanedText).toBe("Status:\n\nWhat next?");
	});

	it("findInteractionRegions reports character bounds", () => {
		const text = "x[CHOICE:s id=i]\na=A\n[/CHOICE]y";
		const regions = findInteractionRegions(text);
		expect(regions).toHaveLength(1);
		expect(text.slice(regions[0].start, regions[0].end)).toContain(
			"[CHOICE:s id=i]",
		);
	});
});

describe("serialize", () => {
	it("round-trips a choice block", () => {
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "abc",
			scope: "approve",
			options: [
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			],
		};
		const text = serializeInteractionBlock(block);
		const { blocks } = parseInteractionBlocks(text);
		expect(blocks[0]).toMatchObject({
			kind: "choice",
			scope: "approve",
			id: "abc",
		});
	});

	it("round-trips a form block", () => {
		const block: FormInteraction = {
			kind: "form",
			id: "f1",
			title: "Creds",
			submitLabel: "Go",
			fields: [{ name: "key", type: "text", required: true }],
		};
		const { blocks } = parseInteractionBlocks(serializeInteractionBlock(block));
		expect(blocks[0]).toMatchObject({
			kind: "form",
			id: "f1",
			title: "Creds",
			submitLabel: "Go",
		});
	});

	it("secret blocks have no text form", () => {
		const block: SecretInteraction = {
			kind: "secret",
			id: "s1",
			secretKind: "secret",
		};
		expect(serializeInteractionBlock(block)).toBe("");
	});

	it("appendInteractionBlock separates from existing prose", () => {
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "i",
			scope: "s",
			options: [{ value: "a", label: "A" }],
		};
		const out = appendInteractionBlock("Hello", block);
		expect(out.startsWith("Hello\n\n[CHOICE:")).toBe(true);
	});
});

describe("callback codec", () => {
	it("encodes and decodes a reply answer", () => {
		const data = encodeReplyCallback("yes");
		expect(data).not.toBeNull();
		expect(isInteractionCallback(data)).toBe(true);
		expect(decodeCallback(data)).toEqual({ kind: "reply", value: "yes" });
	});

	it("returns null when the answer exceeds the platform limit", () => {
		const big = "x".repeat(MAX_CALLBACK_BYTES + 10);
		expect(encodeReplyCallback(big)).toBeNull();
	});

	it("ignores foreign callback payloads", () => {
		expect(decodeCallback("discord:somethingelse")).toBeNull();
		expect(isInteractionCallback(undefined)).toBe(false);
	});
});

describe("layout", () => {
	it("lays out choice options as button rows that round-trip", () => {
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "i",
			scope: "s",
			prompt: "Pick",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
				{ value: "d", label: "D" },
			],
		};
		const layout = toNeutralLayout(block, { maxButtonsPerRow: 3 });
		expect(layout.text).toBe("Pick");
		expect(layout.rows).toHaveLength(2);
		const first = layout.rows[0].buttons?.[0];
		expect(decodeCallback(first?.callbackData)).toEqual({
			kind: "reply",
			value: "a",
		});
	});

	it("marks allowCustom choices as needing a free-text fallback", () => {
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "i",
			scope: "s",
			allowCustom: true,
			options: [{ value: "a", label: "A" }],
		};
		expect(toNeutralLayout(block).needsFallback).toBe(true);
	});

	it("links out a secret block to a resolved url", () => {
		const block: SecretInteraction = {
			kind: "secret",
			id: "s1",
			secretKind: "oauth",
			provider: "GitHub",
		};
		const layout = toNeutralLayout(block, {
			resolveUrl: () => "https://x/secure",
		});
		expect(layout.rows[0].buttons?.[0]).toMatchObject({
			label: "Connect GitHub",
			url: "https://x/secure",
		});
	});

	it("falls back when a form has no link-out url", () => {
		const block: FormInteraction = {
			kind: "form",
			id: "f",
			fields: [{ name: "k", type: "text" }],
		};
		expect(toNeutralLayout(block).needsFallback).toBe(true);
	});
});

describe("normalize", () => {
	it("attaches parsed blocks without mutating text", () => {
		const content: Content = {
			text: "Pick:\n[CHOICE:s id=i]\na=A\nb=B\n[/CHOICE]",
		};
		const out = normalizeContentInteractions(content);
		expect(out.interactions).toHaveLength(1);
		expect(out.text).toBe(content.text); // text preserved for the dashboard renderer
	});

	it("is a no-op when there are no blocks", () => {
		const content: Content = { text: "just a reply" };
		expect(normalizeContentInteractions(content)).toBe(content);
	});

	it("stripInteractionMarkers returns prose only", () => {
		expect(stripInteractionMarkers("Hi\n[CHOICE:s id=i]\na=A\n[/CHOICE]")).toBe(
			"Hi",
		);
	});
});
