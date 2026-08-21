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
import { stripDashboardOnlyMarkers } from "./dashboard-markers";
import {
	buildInteractionUrlResolver,
	FORM_FREE_TEXT_INVITE,
	renderContentInteractionsAsPlainText,
	renderInteractionsAsPlainText,
	toNeutralLayout,
	toPlainTextFallback,
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
	it("scans a 100k-character unterminated block without backtracking", () => {
		const text = `[FORM]\n${"[FORM]a".repeat(12_500)}`;
		expect(findInteractionRegions(text)).toEqual([]);
	});

	it("skips an invalid opener without hiding a later valid block", () => {
		const text = `[FORM extra]\nignored\n[FORM]\n${JSON.stringify({
			fields: [{ name: "ok", type: "text" }],
		})}\n[/FORM]`;
		expect(parseInteractionBlocks(text).blocks).toMatchObject([
			{ kind: "form", fields: [{ name: "ok", type: "text" }] },
		]);
	});

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
		expect(form.fields.map((f) => f.type)).toEqual([
			"date",
			"time",
			"datetime",
		]);
		// parse ↔ serialize parity: the temporal types survive a round trip.
		const rt = parseInteractionBlocks(serializeInteractionBlock(form));
		expect((rt.blocks[0] as FormInteraction).fields.map((f) => f.type)).toEqual(
			["date", "time", "datetime"],
		);
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

	it("drops inherited Object field names from form blocks (#14489)", () => {
		const text = `[FORM]\n${JSON.stringify({
			fields: [
				{ name: "constructor", type: "text" },
				{ name: "hasOwnProperty", type: "text" },
				{ name: "propertyIsEnumerable", type: "text" },
				{ name: "__proto__", type: "text" },
				{ name: "ok", type: "text" },
			],
		})}\n[/FORM]`;
		const { blocks } = parseInteractionBlocks(text);
		const form = blocks[0] as FormInteraction;
		expect(form.fields.map((f) => f.name)).toEqual(["ok"]);

		const onlyUnsafe = `[FORM]\n${JSON.stringify({
			fields: [
				{ name: "constructor", type: "text" },
				{ name: "hasOwnProperty", type: "text" },
			],
		})}\n[/FORM]`;
		const { blocks: unsafeBlocks, cleanedText } =
			parseInteractionBlocks(onlyUnsafe);
		expect(unsafeBlocks).toHaveLength(0);
		expect(cleanedText).toContain("[FORM]");
	});

	it("rejects malformed form JSON (left as text)", () => {
		const text = "[FORM]\n{not json}\n[/FORM]";
		const { blocks, cleanedText } = parseInteractionBlocks(text);
		expect(blocks).toHaveLength(0);
		expect(cleanedText).toContain("[FORM]");
	});

	it("rejects a form whose closing marker is not on a new line", () => {
		const text = '[FORM]\n{"title":"Login","fields":[]}[/FORM]';
		const { blocks, cleanedText } = parseInteractionBlocks(text);
		expect(blocks).toHaveLength(0);
		expect(cleanedText).toBe(text);
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

	// #14323 — scheduling forms need native pickers; values submit as
	// YYYY-MM-DD / HH:mm / YYYY-MM-DDTHH:mm strings.
	it("parses and round-trips date/time/datetime field types (#14323)", () => {
		const text = `[FORM]\n${JSON.stringify({
			id: "sched",
			title: "Set your reminder",
			fields: [
				{ name: "day", type: "date", label: "Day" },
				{ name: "at", type: "time", label: "At" },
				{ name: "exact", type: "datetime", label: "Exact moment" },
			],
		})}\n[/FORM]`;
		const { blocks } = parseInteractionBlocks(text);
		const form = blocks[0] as FormInteraction;
		expect(form.fields.map((f) => f.type)).toEqual([
			"date",
			"time",
			"datetime",
		]);
		const reparsed = parseInteractionBlocks(serializeInteractionBlock(form));
		expect((reparsed.blocks[0] as FormInteraction).fields).toEqual(form.fields);
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

	it("uses a caller-provided platform callback limit", () => {
		const value = "x".repeat(MAX_CALLBACK_BYTES + 10);
		const data = encodeReplyCallback(value, { maxBytes: 100 });
		expect(data).not.toBeNull();
		expect(decodeCallback(data)).toEqual({ kind: "reply", value });
	});

	it("ignores foreign callback payloads", () => {
		expect(decodeCallback("discord:somethingelse")).toBeNull();
		expect(isInteractionCallback(undefined)).toBe(false);
	});

	// #14527 — the 64-byte default is Telegram's cap, not a universal one.
	// Discord's custom_id allows 100 chars; a value that fits the platform's
	// own limit must encode and round-trip through the limit-agnostic decoder.
	it("honors a per-platform limit larger than the Telegram default (#14527)", () => {
		const value = "x".repeat(80);
		expect(encodeReplyCallback(value)).toBeNull();
		const data = encodeReplyCallback(value, { maxBytes: 100 });
		expect(data).not.toBeNull();
		expect(decodeCallback(data)).toEqual({ kind: "reply", value });
	});

	it("still rejects values past the custom limit", () => {
		expect(encodeReplyCallback("x".repeat(120), { maxBytes: 100 })).toBeNull();
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
		expect(layout.rows).toEqual([
			{ buttons: expect.any(Array) },
			{ buttons: expect.any(Array) },
		]);
		const first = layout.rows[0].buttons?.[0];
		expect(decodeCallback(first?.callbackData)).toEqual({
			kind: "reply",
			value: "a",
		});
	});

	it("rejects non-positive maxButtonsPerRow instead of hanging", () => {
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "i",
			scope: "s",
			prompt: "Pick",
			options: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
		};
		for (const perRow of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				toNeutralLayout(block, { maxButtonsPerRow: perRow }),
			).toThrow(RangeError);
		}
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

	it("keeps the default Telegram-safe callback cap unless a platform overrides it", () => {
		const value = "x".repeat(MAX_CALLBACK_BYTES + 10);
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "i",
			scope: "s",
			options: [{ value, label: "Long value" }],
		};

		const defaultLayout = toNeutralLayout(block);
		expect(defaultLayout.rows).toEqual([]);
		expect(defaultLayout.needsFallback).toBe(true);

		const discordLayout = toNeutralLayout(block, { maxCallbackBytes: 100 });
		const button = discordLayout.rows[0]?.buttons?.[0];
		expect(button?.label).toBe("Long value");
		expect(decodeCallback(button?.callbackData)).toEqual({
			kind: "reply",
			value,
		});
		expect(discordLayout.needsFallback).toBe(false);
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

	// #14527 — connectors with a roomier callback budget (Discord: 100-char
	// custom_id) pass maxCallbackBytes so long option values still render as
	// native buttons instead of dropping to the free-text fallback.
	it("renders long choice values as buttons under maxCallbackBytes (#14527)", () => {
		const value = "y".repeat(80);
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "i",
			scope: "s",
			options: [{ value, label: "Long" }],
		};
		const capped = toNeutralLayout(block);
		expect(capped.rows).toHaveLength(0);
		expect(capped.needsFallback).toBe(true);

		const layout = toNeutralLayout(block, { maxCallbackBytes: 100 });
		const button = layout.rows[0]?.buttons?.[0];
		expect(layout.needsFallback).toBeFalsy();
		expect(decodeCallback(button?.callbackData)).toEqual({
			kind: "reply",
			value,
		});
	});

	it("threads maxCallbackBytes through followup chips (#14527)", () => {
		const payload = "z".repeat(80);
		const block: FollowupsInteraction = {
			kind: "followups",
			id: "f1",
			options: [{ kind: "reply", payload, label: "Big" }],
		};
		expect(toNeutralLayout(block).rows).toHaveLength(0);
		const button = toNeutralLayout(block, { maxCallbackBytes: 100 }).rows[0]
			?.buttons?.[0];
		expect(decodeCallback(button?.callbackData)).toEqual({
			kind: "reply",
			value: payload,
		});
	});
});

describe("plain text fallback", () => {
	it("renders choice options as a numbered reply list", () => {
		const block: ChoiceInteraction = {
			kind: "choice",
			id: "i",
			scope: "s",
			prompt: "Pick a lane",
			allowCustom: true,
			options: [
				{ value: "ship", label: "Ship it" },
				{ value: "hold", label: "Hold" },
			],
		};
		expect(toPlainTextFallback(block)).toBe(
			"Pick a lane\n1. Ship it\n2. Hold\nReply with a number or your own answer.",
		);
	});

	it("renders forms as title, description, and the free-text invite", () => {
		const block: FormInteraction = {
			kind: "form",
			id: "f",
			title: "Schedule reminder",
			description: "Tell me when to check in.",
			fields: [{ name: "when", type: "datetime" }],
		};
		expect(toPlainTextFallback(block)).toBe(
			`Schedule reminder\n\nTell me when to check in.\n\n${FORM_FREE_TEXT_INVITE}`,
		);
	});

	it("renders task deep links and followup suggestions without markers", () => {
		const task: TaskInteraction = {
			kind: "task",
			threadId: "task-1",
			title: "Review launch checklist",
		};
		expect(
			toPlainTextFallback(task, {
				resolveUrl: () => "https://app.test/task-1",
			}),
		).toBe("Review launch checklist\nhttps://app.test/task-1");

		const followups: FollowupsInteraction = {
			kind: "followups",
			id: "f1",
			options: [
				{ kind: "navigate", payload: "/tasks", label: "Tasks" },
				{ kind: "reply", payload: "yes", label: "Yes" },
				{ kind: "prompt", payload: "explain", label: "Explain" },
			],
		};
		expect(
			toPlainTextFallback(followups, {
				resolveNavigateUrl: (payload) => `https://app.test${payload}`,
			}),
		).toBe("Suggestions: Tasks (https://app.test/tasks) / Yes / Explain");
	});

	it("does not inline sensitive requests on text-only transports", () => {
		const withUrl: SecretInteraction = {
			kind: "secret",
			id: "s1",
			secretKind: "oauth",
			reason: "Connect GitHub to continue",
			url: "https://oauth.test/consent",
		};
		expect(toPlainTextFallback(withUrl)).toBe(
			"Connect GitHub to continue\nhttps://oauth.test/consent",
		);

		const withoutUrl: SecretInteraction = {
			kind: "secret",
			id: "s2",
			secretKind: "secret",
			reason: "Enter your API key",
			fields: [{ name: "apiKey", type: "secret" }],
		};
		expect(toPlainTextFallback(withoutUrl)).toBe(
			"Enter your API key\nA secure link for this is not available here yet.",
		);
	});
});

describe("renderInteractionsAsPlainText", () => {
	it("passes plain text through unchanged", () => {
		expect(renderInteractionsAsPlainText("just a normal reply")).toEqual({
			text: "just a normal reply",
			hadBlocks: false,
		});
		expect(renderInteractionsAsPlainText(undefined)).toEqual({
			text: "",
			hadBlocks: false,
		});
	});

	it("strips a long form before downstream chunking can split marker JSON", () => {
		const bigForm = JSON.stringify({
			title: "Trip",
			description: "Tell me what changed.",
			fields: [{ name: "a", type: "text", label: "x".repeat(6000) }],
		});
		const { text, hadBlocks } = renderInteractionsAsPlainText(
			`Let's set this up.\n[FORM]\n${bigForm}\n[/FORM]`,
		);

		expect(hadBlocks).toBe(true);
		expect(text).not.toContain("[FORM]");
		expect(text).not.toContain('"fields"');
		expect(text).not.toContain("xxxx");
		expect(text).toContain("Trip");
		expect(text).toContain("Tell me what changed.");
		expect(text).toContain(FORM_FREE_TEXT_INVITE);
	});

	it("strips dashboard markers contributed by parsed block fallbacks", () => {
		const taskId = "abc12345-def6-7890-abcd-ef1234567890";
		// A URL-less task widget contributes NOTHING to plain text — its bare
		// title read as a dangling duplicate line under the ack on chat
		// transports (2026-08-19). hadBlocks still reports the widget.
		expect(
			renderInteractionsAsPlainText(
				`[TASK:${taskId}]Ship it [CONFIG:@elizaos/plugin-gmail][/TASK]`,
			),
		).toEqual({ text: "", hadBlocks: true });

		const form = JSON.stringify({
			title: "Configure account [CONFIG:@elizaos/plugin-gmail]",
			fields: [{ name: "account", type: "text" }],
		});
		// The documented block form requires newlines around the JSON body
		// (parse.ts header; the malformed-marker containment regex deliberately
		// rejects inline bodies).
		const rendered = renderInteractionsAsPlainText(`[FORM]\n${form}\n[/FORM]`);
		expect(rendered.hadBlocks).toBe(true);
		expect(rendered.text).toBe(`Configure account\n\n${FORM_FREE_TEXT_INVITE}`);
	});
});

describe("renderContentInteractionsAsPlainText", () => {
	it("renders typed secret interactions that have no bracket-marker text form", () => {
		const { text, hadBlocks } = renderContentInteractionsAsPlainText({
			text: "Connect this account.",
			interactions: [
				{
					kind: "secret",
					id: "s1",
					secretKind: "oauth",
					reason: "Connect GitHub to continue",
					url: "https://oauth.test/consent",
				},
			],
		});

		expect(hadBlocks).toBe(true);
		expect(text).toBe(
			"Connect this account.\n\nConnect GitHub to continue\nhttps://oauth.test/consent",
		);
	});

	it("strips dashboard markers contributed by typed interactions", () => {
		const rendered = renderContentInteractionsAsPlainText({
			text: "Review:",
			interactions: [
				{
					kind: "task",
					threadId: "task-1",
					title: "Ship it [CONFIG:@elizaos/plugin-gmail]",
				},
			],
		});

		expect(rendered).toEqual({ text: "Review:", hadBlocks: true });
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

	it("removes terminal unclaimed machinery before outbound delivery", () => {
		const content: Content = {
			text: "Done.\n[ FOLLOWUPS ]\nreply:Again=Again",
		};
		expect(normalizeContentInteractions(content)).toEqual({ text: "Done." });
	});
});

describe("interaction marker residue", () => {
	it("parses spaced CRLF blocks, including TASK whitespace before the bracket", () => {
		const taskId = "0123abcd-1234-5678-9abc-deadbeefcafe";
		const text = [
			"Done.",
			"[ FOLLOWUPS ]\r\nreply:More=More\r\n[ / FOLLOWUPS ]",
			"[ CHOICE: pick ]\r\nyes=Yes\r\n[ / CHOICE ]",
			`[ TASK: ${taskId} ]Ship it[ / TASK ]`,
		].join("\r\n");
		const { blocks, cleanedText } = parseInteractionBlocks(text);
		expect(blocks.map((block) => block.kind)).toEqual([
			"followups",
			"choice",
			"task",
		]);
		expect(cleanedText).toBe("Done.");
	});

	it("strips a terminal half-open block across blanks and malformed close rows", () => {
		const { blocks, cleanedText } = parseInteractionBlocks(
			"Here you go.\r\n[ FOLLOWUPS ]\r\nreply:More=More\r\n\r\nprompt:Again=Again\r\n[ /FOLLOWUP ]",
		);
		expect(blocks).toEqual([]);
		expect(cleanedText).toBe("Here you go.");
	});

	it("preserves malformed marker prose when ordinary prose follows it", () => {
		const text =
			"[ FOLLOWUPS ]\nreply:More=More\nThis paragraph explains the malformed example.";
		expect(parseInteractionBlocks(text).cleanedText).toBe(text);
	});

	it("preserves marker examples inside fenced Markdown", () => {
		const text = "Example:\n```text\n[ FOLLOWUPS ]\nreply:More=More\n```";
		expect(parseInteractionBlocks(text).cleanedText).toBe(text);
	});

	it("preserves invalid FORM data", () => {
		const text =
			'[ FORM ]\r\n{"fields":[{"name":"constructor","type":"text"}]}\r\n[ / FORM ]';
		expect(parseInteractionBlocks(text).cleanedText).toBe(text);
	});

	it("ships swept text through the zero-block plain-text renderer", () => {
		const { text, hadBlocks } = renderInteractionsAsPlainText(
			"here you go.\n[ FOLLOWUPS ]\nreply:More=More",
		);
		expect(hadBlocks).toBe(false);
		expect(text).toBe("here you go.");
	});

	it("keeps block-free prose byte-identical through the plain-text renderer", () => {
		const text = "i read [the docs] and [section 2] carefully.";
		expect(renderInteractionsAsPlainText(text)).toEqual({
			text,
			hadBlocks: false,
		});
	});
});

describe("unclaimed interaction markers never ship as prose", () => {
	// Live 2026-08-14: a Discord reply ended with a raw
	//   [ FOLLOWUPS ]\nreply:Show me a joke=Show joke\n[ /FOLLOWUPS ]
	// block. The spaced variant missed the whitespace-strict regex, so nothing
	// claimed it and nothing removed it — it shipped to the user as literal text.
	const spaced =
		"dad jokes page is done.\n\n[ FOLLOWUPS ]\nreply:Show me a joke=Show joke\nreply:Add more jokes=Expand jokes\n[ /FOLLOWUPS ]";

	it("parses the spaced variant into blocks instead of leaking it", () => {
		const { blocks, cleanedText } = parseInteractionBlocks(spaced);
		expect(blocks.length).toBe(1);
		expect(cleanedText).toBe("dad jokes page is done.");
		expect(cleanedText).not.toContain("FOLLOWUPS");
		expect(cleanedText).not.toContain("reply:");
	});

	it("strips a half-open marker the parser cannot claim", () => {
		const { cleanedText } = parseInteractionBlocks(
			"here you go.\n[ FOLLOWUPS ]\nreply:More=More",
		);
		expect(cleanedText).toBe("here you go.");
	});

	it("keeps an unsafe FORM's text — #14489 carries user data", () => {
		// Reconciles with #14489: FORM is data, the others are affordances. A form
		// whose fields were all rejected must NOT be silently deleted.
		const { blocks, cleanedText } = parseInteractionBlocks(
			'[FORM]\n{"fields":[{"name":"constructor","type":"text"}]}\n[/FORM]',
		);
		expect(blocks).toHaveLength(0);
		expect(cleanedText).toContain("[FORM]");
	});

	it("leaves ordinary bracketed prose alone", () => {
		const text = "i read [the docs] and [section 2] carefully.";
		expect(parseInteractionBlocks(text).cleanedText).toBe(text);
	});

	it("does not eat a normal sentence containing a colon and equals", () => {
		const text = "set the flag: enabled=true in your config.";
		expect(parseInteractionBlocks(text).cleanedText).toBe(text);
	});

	// A parser that sweeps residue is necessary but not sufficient: a renderer
	// that echoes its RAW input on the zero-block branch discards the sweep, and
	// zero-block is precisely the branch residue survives on. The Discord and
	// Telegram renderers already return their cleaned text here; the plain-text
	// path was the last one still handing back the source.
	it("renders the swept text on the zero-block plain-text path", () => {
		const { text, hadBlocks } = renderInteractionsAsPlainText(
			"here you go.\n[ FOLLOWUPS ]\nreply:More=More",
		);
		expect(hadBlocks).toBe(false);
		expect(text).not.toContain("FOLLOWUPS");
		expect(text).not.toContain("reply:");
		expect(text).toBe("here you go.");
	});

	it("leaves block-free ordinary prose byte-identical through the renderer", () => {
		const text = "i read [the docs] and [section 2] carefully.";
		expect(renderInteractionsAsPlainText(text).text).toBe(text);
	});
});

describe("stripDashboardOnlyMarkers", () => {
	it("scans a 100k-character unterminated widget without backtracking", () => {
		const input = `[CHECKLIST]\n${"[CHECKLIST]a".repeat(8_334)}`;
		expect(stripDashboardOnlyMarkers(input)).toBe(input);
	});

	it("removes CONFIG plugin-card markers and tidies the gap they leave", () => {
		const input =
			"You'll need to connect Google Calendar first.\n\n[CONFIG:google_calendars]\n\nThen I can list your events.";
		expect(stripDashboardOnlyMarkers(input)).toBe(
			"You'll need to connect Google Calendar first.\n\nThen I can list your events.",
		);
	});

	it("leaves ordinary prose and interaction grammar untouched", () => {
		const untouched =
			"[FOLLOWUPS]\nnavigate:/apps/reminders=Open reminders\n[/FOLLOWUPS]\nPlain text with [brackets] that are not markers.";
		expect(stripDashboardOnlyMarkers(untouched)).toBe(untouched);
		expect(stripDashboardOnlyMarkers("no markers at all")).toBe(
			"no markers at all",
		);
	});

	it("is part of the canonical connector text boundary", () => {
		const source =
			"Connect it. [CONFIG:google_calendars]\n[FOLLOWUPS]\nreply:yes=Yes\n[/FOLLOWUPS]";
		const parsed = parseInteractionBlocks(source);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.cleanedText).toBe("Connect it.");
		expect(renderInteractionsAsPlainText(source).text).not.toContain("CONFIG");
	});

	it("degrades a [CHECKLIST] block to a plain task list (tj-578adf524ebb7a)", () => {
		const input =
			'Working through it now.\n\n[CHECKLIST]\n{"title":"Migration","items":[{"content":"Back up the database","status":"completed"},{"content":"Run the migration","status":"in_progress"},{"content":"Verify downstream consumers"}]}\n[/CHECKLIST]';
		expect(stripDashboardOnlyMarkers(input)).toBe(
			"Working through it now.\n\nMigration:\n- [x] Back up the database\n- [~] Run the migration\n- [ ] Verify downstream consumers",
		);
	});

	it("degrades a [WORKFLOW] block to numbered steps with status", () => {
		const input =
			'[WORKFLOW]\n{"title":"Deploy","steps":[{"label":"Build image","status":"done"},{"label":"Push to registry","status":"running"},{"label":"Roll out"}]}\n[/WORKFLOW]';
		expect(stripDashboardOnlyMarkers(input)).toBe(
			"Deploy:\n1. Build image — done\n2. Push to registry — running\n3. Roll out — pending",
		);
	});

	it("keeps a malformed widget body as text with the wire markers removed", () => {
		const input =
			"Here's the plan.\n[CHECKLIST]\nnot json at all\n[/CHECKLIST]";
		expect(stripDashboardOnlyMarkers(input)).toBe(
			"Here's the plan.\nnot json at all",
		);
	});

	it("strips the bare [BACKGROUND] picker marker", () => {
		expect(
			stripDashboardOnlyMarkers("Pick a wallpaper below.\n\n[BACKGROUND]"),
		).toBe("Pick a wallpaper below.");
	});

	it("keeps widget blocks out of the connector plain-text projection", () => {
		const source =
			'Status update:\n[CHECKLIST]\n{"items":[{"content":"Ship it","status":"pending"}]}\n[/CHECKLIST]\n[FOLLOWUPS]\nreply:continue=Continue\n[/FOLLOWUPS]';
		const rendered = renderInteractionsAsPlainText(source).text;
		expect(rendered).not.toContain("[CHECKLIST]");
		expect(rendered).not.toContain("{");
		expect(rendered).toContain("- [ ] Ship it");
	});
});
