/**
 * Round-trip and behavior tests for the message-interaction block pipeline —
 * parse, serialize, normalize, callback codec, and neutral button layout for
 * the `[CHOICE]` / `[FORM]` / `[TASK]` / `[FOLLOWUPS]` / `[SECRET]` markers
 * embedded in message content. Pure deterministic functions; no model or DB.
 */
import { describe, expect, it } from "vitest";
import type {
	ChoiceInteraction,
	Content,
	FollowupsInteraction,
	FormInteraction,
	SecretInteraction,
	TaskInteraction,
} from "../../types";
import {
	decodeCallback,
	encodeReplyCallback,
	isInteractionCallback,
	MAX_CALLBACK_BYTES,
} from "./callback";
import {
	buildInteractionUrlResolver,
	FORM_FREE_TEXT_INVITE,
	toNeutralLayout,
} from "./layout";
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

	it("parses an image field with mimeTypes + maxBytes (#8910)", () => {
		const text = `[FORM]\n${JSON.stringify({
			title: "2FA",
			fields: [
				{
					name: "seed_photo",
					type: "image",
					label: "Photo of seed",
					mimeTypes: ["image/png", "image/jpeg"],
					maxBytes: 5_000_000,
					required: true,
				},
				{ name: "doc", type: "file" },
				{ name: "ignored_mimes", type: "text", mimeTypes: ["image/png"] },
			],
		})}\n[/FORM]`;
		const { blocks } = parseInteractionBlocks(text);
		const form = blocks[0] as FormInteraction;
		const image = form.fields.find((f) => f.name === "seed_photo");
		expect(image?.type).toBe("image");
		expect(image?.mimeTypes).toEqual(["image/png", "image/jpeg"]);
		expect(image?.maxBytes).toBe(5_000_000);
		expect(form.fields.find((f) => f.name === "doc")?.type).toBe("file");
		// mimeTypes/maxBytes only attach to image/file fields, not text.
		expect(form.fields.find((f) => f.name === "ignored_mimes")?.mimeTypes).toBe(
			undefined,
		);
	});

	it("parses temporal field types and round-trips them (#14323)", () => {
		const text = `[FORM]\n${JSON.stringify({
			title: "Schedule reminder",
			fields: [
				{ name: "day", type: "date", label: "Day", required: true },
				{ name: "at", type: "time", label: "At" },
				{ name: "when", type: "datetime", label: "When" },
			],
		})}\n[/FORM]`;
		const { blocks } = parseInteractionBlocks(text);
		const form = blocks[0] as FormInteraction;
		expect(form.fields.map((f) => f.type)).toEqual(["date", "time", "datetime"]);
		// parse ↔ serialize parity: the temporal types survive a round trip.
		const rt = parseInteractionBlocks(serializeInteractionBlock(form));
		expect((rt.blocks[0] as FormInteraction).fields.map((f) => f.type)).toEqual([
			"date",
			"time",
			"datetime",
		]);
	});

	it("drops a field with an unknown type (core parser is strict)", () => {
		const text = `[FORM]\n${JSON.stringify({
			fields: [
				{ name: "ok", type: "date" },
				{ name: "bad", type: "color" },
			],
		})}\n[/FORM]`;
		const { blocks } = parseInteractionBlocks(text);
		const form = blocks[0] as FormInteraction;
		// unknown "color" is rejected; the valid "date" field survives.
		expect(form.fields.map((f) => f.name)).toEqual(["ok"]);
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

	it("falls back when a form has no link-out url (#14321)", () => {
		const block: FormInteraction = {
			kind: "form",
			id: "f",
			title: "Set your reminder",
			fields: [{ name: "k", type: "text" }],
		};
		const layout = toNeutralLayout(block);
		expect(layout.needsFallback).toBe(true);
		expect(layout.rows).toHaveLength(0);
		expect(layout.text).toBe(`Set your reminder\n\n${FORM_FREE_TEXT_INVITE}`);
	});

	it("invites a free-text reply even when a form has no title or description", () => {
		const block: FormInteraction = {
			kind: "form",
			id: "f",
			fields: [{ name: "k", type: "text" }],
		};
		expect(toNeutralLayout(block).text).toBe(FORM_FREE_TEXT_INVITE);
	});

	it("uses a non-blank form description when the title is blank", () => {
		const block: FormInteraction = {
			kind: "form",
			id: "f",
			title: "  ",
			description: "Tell us when to remind you.",
			fields: [{ name: "k", type: "text" }],
		};
		expect(toNeutralLayout(block).text).toBe(
			`Tell us when to remind you.\n\n${FORM_FREE_TEXT_INVITE}`,
		);
	});

	// #8908 — navigate followups render as link-out buttons when a URL resolver
	// is supplied; reply/prompt chips keep their reply-callback behavior.
	it("renders a navigate followup as a url button via resolveNavigateUrl", () => {
		const block: FollowupsInteraction = {
			kind: "followups",
			id: "f1",
			options: [
				{ kind: "navigate", payload: "/tasks", label: "Open tasks" },
				{ kind: "reply", payload: "yes", label: "Yes" },
			],
		};
		const layout = toNeutralLayout(block, {
			resolveNavigateUrl: (p) => `https://app.test${p}`,
		});
		const buttons = layout.rows.flatMap((r) => r.buttons ?? []);
		const nav = buttons.find((b) => b.label === "Open tasks");
		const reply = buttons.find((b) => b.label === "Yes");
		expect(nav?.url).toBe("https://app.test/tasks");
		expect(nav?.callbackData).toBeUndefined();
		expect(reply?.url).toBeUndefined();
		expect(decodeCallback(reply?.callbackData)).toEqual({
			kind: "reply",
			value: "yes",
		});
	});

	it("keeps navigate followups as reply callbacks when no resolver is given", () => {
		const block: FollowupsInteraction = {
			kind: "followups",
			id: "f1",
			options: [{ kind: "navigate", payload: "/tasks", label: "Open tasks" }],
		};
		const button = toNeutralLayout(block).rows[0]?.buttons?.[0];
		expect(button?.url).toBeUndefined();
		expect(button?.callbackData).toBeTruthy();
	});
});

describe("buildInteractionUrlResolver (#8908)", () => {
	const resolver = buildInteractionUrlResolver("https://app.test/");

	it("returns no resolvers when no base url is configured", () => {
		expect(buildInteractionUrlResolver(undefined)).toEqual({});
		expect(buildInteractionUrlResolver("")).toEqual({});
	});

	it("resolves a task block to the orchestrator deep link", () => {
		const block: TaskInteraction = {
			kind: "task",
			threadId: "abc-123",
			title: "Build it",
		};
		expect(resolver.resolveUrl?.(block)).toBe(
			"https://app.test/orchestrator?taskId=abc-123",
		);
	});

	// #14321 — there is no hosted /forms/:id page and form specs are never
	// persisted, so a form block must NOT mint a link-out (that would be a dead
	// route). It resolves to undefined and the layout degrades to a free-text
	// reply, while a hosted-page block type (task) still resolves its real URL.
	it("does not mint a link-out for a form block (no hosted page → free-text fallback)", () => {
		const form: FormInteraction = {
			kind: "form",
			id: "form_7",
			fields: [{ name: "k", type: "text" }],
		};
		expect(resolver.resolveUrl?.(form)).toBeUndefined();

		const layout = toNeutralLayout(form, resolver);
		expect(layout.needsFallback).toBe(true);
		expect(layout.rows).toEqual([]);
		// No button anywhere points at the nonexistent /forms/ route.
		const urls = layout.rows.flatMap((r) => r.buttons ?? []).map((b) => b.url);
		expect(urls).not.toContain("https://app.test/forms/form_7");

		// A block type that DOES have a hosted page still resolves normally.
		const task: TaskInteraction = {
			kind: "task",
			threadId: "abc-123",
			title: "Build it",
		};
		expect(resolver.resolveUrl?.(task)).toBe(
			"https://app.test/orchestrator?taskId=abc-123",
		);
		expect(toNeutralLayout(task, resolver).rows[0]?.buttons?.[0]?.url).toBe(
			"https://app.test/orchestrator?taskId=abc-123",
		);
	});

	it("resolves navigate payloads (path + viewId) against the base url", () => {
		expect(resolver.resolveNavigateUrl?.("/tasks")).toBe(
			"https://app.test/tasks",
		);
		expect(resolver.resolveNavigateUrl?.("inbox")).toBe(
			"https://app.test/?view=inbox",
		);
	});

	it("defers secret/oauth blocks to their own out-of-band url", () => {
		const block: SecretInteraction = {
			kind: "secret",
			id: "s1",
			secretKind: "oauth",
			provider: "GitHub",
			url: "https://oauth.test/consent",
		};
		// resolver returns undefined → layout falls back to block.url
		expect(resolver.resolveUrl?.(block)).toBeUndefined();
		const layout = toNeutralLayout(block, resolver);
		expect(layout.rows[0]?.buttons?.[0]?.url).toBe(
			"https://oauth.test/consent",
		);
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
