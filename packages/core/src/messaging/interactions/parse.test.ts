/**
 * Behavioral coverage for the connector-agnostic interaction-block parser:
 * marker scanning for CHOICE / FOLLOWUPS / FORM / TASK blocks, option and
 * form-field validation, capacity caps, unclaimed-terminal-markup stripping,
 * and the parseInteractionBlocks cleaned-text projection. Deterministic unit
 * suite — it drives the real module with inline fixtures, no mocks and no
 * clocks; generated interaction ids come from the platform UUID source and
 * are therefore only asserted to be distinct, non-empty strings.
 */
import { describe, expect, it } from "vitest";

import type {
	ChoiceInteraction,
	FollowupsInteraction,
	FormInteraction,
	TaskInteraction,
} from "../../types/interactions";
import {
	findInteractionRegions,
	hasInteractionBlocks,
	MAX_FOLLOWUPS,
	MAX_FORM_FIELDS,
	MAX_TASK_TITLE_LEN,
	parseInteractionBlocks,
	stripUnclaimedInteractionMarkup,
} from "./parse.ts";

describe("interaction marker constants", () => {
	it("pins the published capacity caps", () => {
		expect(MAX_FORM_FIELDS).toBe(20);
		expect(MAX_FOLLOWUPS).toBe(4);
		expect(MAX_TASK_TITLE_LEN).toBe(200);
	});
});

describe("hasInteractionBlocks", () => {
	it("detects a well-formed block", () => {
		expect(hasInteractionBlocks("Pick:\n[CHOICE:a]\nx=X\n[/CHOICE]")).toBe(
			true,
		);
	});

	it("rejects plain text, empty input, and unknown markers", () => {
		expect(hasInteractionBlocks("plain words only")).toBe(false);
		expect(hasInteractionBlocks("")).toBe(false);
		expect(hasInteractionBlocks("[WAT]\nx\n[/WAT]")).toBe(false);
	});
});

describe("findInteractionRegions: CHOICE blocks", () => {
	it("parses scope, trimmed options, and skips malformed option lines", () => {
		const text =
			"Pick one:\n[CHOICE:flavor]\nvanilla=Vanilla\nchocolate=Dark Chocolate\n\n=NoValue\nnovalue=\nnoequals\n[/CHOICE]\n";
		const regions = findInteractionRegions(text);
		expect(regions).toHaveLength(1);
		const block = regions[0].block as ChoiceInteraction;
		expect(block.kind).toBe("choice");
		expect(block.scope).toBe("flavor");
		expect(block.options).toEqual([
			{ value: "vanilla", label: "Vanilla" },
			{ value: "chocolate", label: "Dark Chocolate" },
		]);
		expect(typeof block.id).toBe("string");
		expect(block.id.length).toBeGreaterThan(0);
		expect(regions[0].start).toBe(text.indexOf("[CHOICE"));
		expect(regions[0].end).toBe(text.indexOf("[/CHOICE]") + "[/CHOICE]".length);
	});

	it("honors an explicit id and allow_custom regardless of attribute order", () => {
		const first = findInteractionRegions(
			"[CHOICE:flavor id=req-1 allow_custom]\nv=V\n[/CHOICE]",
		);
		const second = findInteractionRegions(
			"[CHOICE:flavor allow_custom id=x7]\nv=V\n[/CHOICE]",
		);
		for (const regions of [first, second]) {
			expect(regions).toHaveLength(1);
			const block = regions[0].block as ChoiceInteraction;
			expect(block.allowCustom).toBe(true);
			expect(["req-1", "x7"]).toContain(block.id);
		}
		expect((first[0].block as ChoiceInteraction).id).toBe("req-1");
		expect((second[0].block as ChoiceInteraction).id).toBe("x7");
	});

	it("drops blocks whose scope is empty or outside the allowed charset", () => {
		expect(findInteractionRegions("[CHOICE:]\nv=V\n[/CHOICE]")).toEqual([]);
		expect(
			findInteractionRegions("[CHOICE:bad!scope]\nv=V\n[/CHOICE]"),
		).toEqual([]);
	});

	it("drops a block whose body yields no usable options", () => {
		expect(
			findInteractionRegions("[CHOICE:a]\nnothing here\n[/CHOICE]"),
		).toEqual([]);
	});

	it("accepts lowercase markers", () => {
		const regions = findInteractionRegions("[choice:c]\na=A\n[/choice]");
		expect(regions).toHaveLength(1);
		expect((regions[0].block as ChoiceInteraction).scope).toBe("c");
	});

	it("swallows a duplicate opener into the active block's body", () => {
		const regions = findInteractionRegions(
			"[CHOICE:a]\nx=1\n[CHOICE:b]\ny=2\n[/CHOICE]",
		);
		expect(regions).toHaveLength(1);
		const block = regions[0].block as ChoiceInteraction;
		expect(block.scope).toBe("a");
		expect(block.options).toEqual([
			{ value: "x", label: "1" },
			{ value: "y", label: "2" },
		]);
	});

	it("requires the body to start on the next line", () => {
		expect(findInteractionRegions("[CHOICE:a] x=1 [/CHOICE]")).toEqual([]);
	});
});

describe("findInteractionRegions: FOLLOWUPS blocks", () => {
	it("maps known kinds, falls back to reply, and keeps payloads verbatim", () => {
		const regions = findInteractionRegions(
			"[FOLLOWUPS id=fu-9]\nreply:yes=Say yes\nnavigate:/home=Go home\nprompt:ask=Ask me\nunknown:x=Mystery\n[/FOLLOWUPS]",
		);
		expect(regions).toHaveLength(1);
		const block = regions[0].block as FollowupsInteraction;
		expect(block.kind).toBe("followups");
		expect(block.id).toBe("fu-9");
		expect(block.options).toEqual([
			{ kind: "reply", payload: "yes", label: "Say yes" },
			{ kind: "navigate", payload: "/home", label: "Go home" },
			{ kind: "prompt", payload: "ask", label: "Ask me" },
			{ kind: "reply", payload: "unknown:x", label: "Mystery" },
		]);
	});

	it("treats a line without a kind prefix as a reply payload", () => {
		const regions = findInteractionRegions(
			"[FOLLOWUPS]\nplain=Bare\n[/FOLLOWUPS]",
		);
		expect(regions).toHaveLength(1);
		const block = regions[0].block as FollowupsInteraction;
		expect(block.options).toEqual([
			{ kind: "reply", payload: "plain", label: "Bare" },
		]);
	});

	it("keeps only the first MAX_FOLLOWUPS options", () => {
		const lines = Array.from(
			{ length: 6 },
			(_, i) => `reply:k${i + 1}=L${i + 1}`,
		).join("\n");
		const regions = findInteractionRegions(
			`[FOLLOWUPS]\n${lines}\n[/FOLLOWUPS]`,
		);
		expect(regions).toHaveLength(1);
		const block = regions[0].block as FollowupsInteraction;
		expect(block.options).toHaveLength(MAX_FOLLOWUPS);
		expect(block.options.map((o) => o.payload)).toEqual([
			"k1",
			"k2",
			"k3",
			"k4",
		]);
	});

	it("rejects id attributes that are empty or contain whitespace", () => {
		expect(
			findInteractionRegions("[FOLLOWUPS id=]\np=L\n[/FOLLOWUPS]"),
		).toEqual([]);
		expect(
			findInteractionRegions("[FOLLOWUPS id=a b]\np=L\n[/FOLLOWUPS]"),
		).toEqual([]);
	});

	it("generates distinct non-empty ids when none is supplied", () => {
		const regions = findInteractionRegions(
			"[FOLLOWUPS]\na=A\n[/FOLLOWUPS]\nthen\n[FOLLOWUPS]\nb=B\n[/FOLLOWUPS]",
		);
		expect(regions).toHaveLength(2);
		const ids = regions.map((r) => (r.block as FollowupsInteraction).id);
		for (const id of ids) {
			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		}
		expect(ids[0]).not.toBe(ids[1]);
	});
});

describe("findInteractionRegions: FORM blocks", () => {
	it("parses a fully featured form with validated fields", () => {
		const body = JSON.stringify({
			id: "form-1",
			title: "Contact",
			description: "Details",
			submitLabel: "Send",
			fields: [
				{
					name: "email",
					type: "text",
					label: "Email",
					placeholder: "you@example.com",
					required: true,
				},
				{
					name: "size",
					type: "select",
					options: [
						{ value: "s", label: "Small" },
						"junk",
						{ value: 1, label: 2 },
					],
				},
				{
					name: "doc",
					type: "file",
					mimeTypes: ["text/plain", 42],
					maxBytes: 2048,
				},
				{ name: "pic", type: "image", mimeTypes: [], maxBytes: 0 },
			],
		});
		const regions = findInteractionRegions(`[FORM]\n${body}\n[/FORM]`);
		expect(regions).toHaveLength(1);
		const form = regions[0].block as FormInteraction;
		expect(form.kind).toBe("form");
		expect(form.id).toBe("form-1");
		expect(form.title).toBe("Contact");
		expect(form.description).toBe("Details");
		expect(form.submitLabel).toBe("Send");
		expect(form.fields).toEqual([
			{
				name: "email",
				type: "text",
				label: "Email",
				placeholder: "you@example.com",
				required: true,
			},
			{
				name: "size",
				type: "select",
				options: [{ value: "s", label: "Small" }],
			},
			{ name: "doc", type: "file", mimeTypes: ["text/plain"], maxBytes: 2048 },
			{ name: "pic", type: "image" },
		]);
	});

	it("applies defaults and omits absent optional keys", () => {
		const regions = findInteractionRegions(
			'[FORM]\n{"fields":[{"name":"a"}]}\n[/FORM]',
		);
		expect(regions).toHaveLength(1);
		const form = regions[0].block as FormInteraction;
		expect(form.submitLabel).toBe("Submit");
		expect(form.title).toBeUndefined();
		expect(form.description).toBeUndefined();
		expect(form.fields[0]).toEqual({ name: "a", type: "text" });
		expect(typeof form.id).toBe("string");
		expect(form.id.length).toBeGreaterThan(0);
	});

	it("ignores malformed JSON, non-object bodies, and bodies without a field array", () => {
		expect(findInteractionRegions("[FORM]\n{broken\n[/FORM]")).toEqual([]);
		expect(findInteractionRegions("[FORM]\n42\n[/FORM]")).toEqual([]);
		expect(findInteractionRegions('[FORM]\n{"id":"x"}\n[/FORM]')).toEqual([]);
	});

	it("ignores a form whose fields are all invalid", () => {
		const body = JSON.stringify({
			fields: [
				{ name: "" },
				{ name: "bad name" },
				{ name: "__proto__" },
				{ name: "constructor" },
				{ name: "ok", type: "textarea" },
			],
		});
		expect(findInteractionRegions(`[FORM]\n${body}\n[/FORM]`)).toEqual([]);
	});

	it("keeps safe names, rejects unsafe ones, and defaults missing types to text", () => {
		const body = JSON.stringify({
			fields: [
				{ name: "__proto__" },
				{ name: "hasOwnProperty" },
				{ name: "bad name" },
				{ name: "dotted.ok" },
				{ name: "hyph-en" },
				{ name: "keep", type: "number" },
			],
		});
		const regions = findInteractionRegions(`[FORM]\n${body}\n[/FORM]`);
		expect(regions).toHaveLength(1);
		const form = regions[0].block as FormInteraction;
		expect(form.fields).toEqual([
			{ name: "dotted.ok", type: "text" },
			{ name: "hyph-en", type: "text" },
			{ name: "keep", type: "number" },
		]);
	});

	it("keeps only the first MAX_FORM_FIELDS valid fields", () => {
		const fields = Array.from({ length: 22 }, (_, i) => ({ name: `f${i}` }));
		const regions = findInteractionRegions(
			`[FORM]\n${JSON.stringify({ fields })}\n[/FORM]`,
		);
		expect(regions).toHaveLength(1);
		const form = regions[0].block as FormInteraction;
		expect(form.fields).toHaveLength(MAX_FORM_FIELDS);
		expect(form.fields.map((f) => f.name)).toEqual(
			Array.from({ length: MAX_FORM_FIELDS }, (_, i) => `f${i}`),
		);
	});
});

describe("findInteractionRegions: TASK blocks", () => {
	it("parses an inline task and reports the exact marker span", () => {
		const text = "Do it [TASK:a1b2c3d4]Fix login[/TASK] now";
		const regions = findInteractionRegions(text);
		expect(regions).toHaveLength(1);
		expect(regions[0].start).toBe(text.indexOf("[TASK"));
		expect(regions[0].end).toBe(text.indexOf("[/TASK]") + "[/TASK]".length);
		const block = regions[0].block as TaskInteraction;
		expect(block.kind).toBe("task");
		expect(block.threadId).toBe("a1b2c3d4");
		expect(block.title).toBe("Fix login");
	});

	it("validates the thread id charset, case, and length window", () => {
		expect(findInteractionRegions("[TASK:A1B2C3D4]x[/TASK]")).toEqual([]);
		expect(findInteractionRegions("[TASK:abc]x[/TASK]")).toEqual([]);
		expect(
			findInteractionRegions(`[TASK:${"a".repeat(64)}]x[/TASK]`),
		).toHaveLength(1);
		expect(findInteractionRegions(`[TASK:${"a".repeat(65)}]x[/TASK]`)).toEqual(
			[],
		);
	});

	it("requires a non-empty title", () => {
		expect(findInteractionRegions("[TASK:a1b2c3d4][/TASK]")).toEqual([]);
	});

	it("truncates long titles to the cap with an ellipsis", () => {
		const regions = findInteractionRegions(
			`[TASK:a1b2c3d4]${"t".repeat(210)}[/TASK]`,
		);
		expect(regions).toHaveLength(1);
		const block = regions[0].block as TaskInteraction;
		expect(block.title).toBe(`${"t".repeat(MAX_TASK_TITLE_LEN - 1)}…`);
	});
});

describe("findInteractionRegions: scanner edges", () => {
	it("returns nothing for an unterminated opening marker", () => {
		expect(findInteractionRegions("[CHOICE:a]\nx=1\n")).toEqual([]);
	});

	it("returns nothing when the text ends inside a marker", () => {
		expect(findInteractionRegions("hello [CHOICE:a")).toEqual([]);
	});

	it("ignores unknown markers entirely", () => {
		expect(findInteractionRegions("[WAT]\na=b\n[/WAT]")).toEqual([]);
	});

	it("ignores a closing marker with no matching opener", () => {
		expect(findInteractionRegions("hi [/CHOICE] bye")).toEqual([]);
	});

	it("ignores a closer carrying unexpected trailing content", () => {
		expect(findInteractionRegions("[CHOICE:a]\nx=1\n[/CHOICE oops]")).toEqual(
			[],
		);
	});

	it("prefers the outermost block when regions overlap", () => {
		const regions = findInteractionRegions(
			"[CHOICE:a]\nx=1\n[TASK:11111111]inner[/TASK]\n[/CHOICE]",
		);
		expect(regions).toHaveLength(1);
		const block = regions[0].block as ChoiceInteraction;
		expect(block.kind).toBe("choice");
		expect(block.scope).toBe("a");
		expect(block.options).toEqual([{ value: "x", label: "1" }]);
	});

	it("handles CRLF bodies and closers", () => {
		const regions = findInteractionRegions(
			"Pick:\r\n[CHOICE:a]\r\nx=1\r\n[/CHOICE]\r\ntail",
		);
		expect(regions).toHaveLength(1);
		expect((regions[0].block as ChoiceInteraction).options).toEqual([
			{ value: "x", label: "1" },
		]);
	});

	it("reports multiple blocks in document order", () => {
		const regions = findInteractionRegions(
			"A [TASK:aaaaaaaa]one[/TASK].\n[CHOICE:s]\nx=1\n[/CHOICE]\n[FOLLOWUPS id=f]\nr:p=P\n[/FOLLOWUPS]\nend",
		);
		expect(regions.map((r) => r.block.kind)).toEqual([
			"task",
			"choice",
			"followups",
		]);
	});
});

describe("stripUnclaimedInteractionMarkup", () => {
	it("leaves text without claimable markers untouched, including FORM residue", () => {
		const text = 'Done.\n[FORM]\n{"fields":[]}\n[/FORM]\n';
		expect(stripUnclaimedInteractionMarkup(text)).toBe(text);
	});

	it("leaves a claimed terminal block untouched", () => {
		const text = "Pick:\n[CHOICE:a]\nx=X\n[/CHOICE]\n";
		expect(stripUnclaimedInteractionMarkup(text)).toBe(text);
	});

	it("leaves a claimed block followed by prose untouched", () => {
		const text = "Pick:\n[CHOICE:a]\nx=X\n[/CHOICE]\nAnyway, thanks!";
		expect(stripUnclaimedInteractionMarkup(text)).toBe(text);
	});

	it("strips a terminal orphaned opener and its option lines", () => {
		expect(
			stripUnclaimedInteractionMarkup("Sure!\n[CHOICE:a]\nx=X\ny=Y\n"),
		).toBe("Sure!");
	});

	it("never rewrites a complete fenced example", () => {
		const text = "Example:\n```\n[CHOICE:a]\nx=X\n[/CHOICE]\n```\n";
		expect(stripUnclaimedInteractionMarkup(text)).toBe(text);
	});

	it("still strips an unclosed orphan that sits behind a closed fence", () => {
		expect(
			stripUnclaimedInteractionMarkup(
				"Look:\n```\nx=X\n```\n[CHOICE:a]\ny=Y\n",
			),
		).toBe("Look:\n```\nx=X\n```");
	});

	it("recognizes known command-prefixed option lines in a suffix", () => {
		expect(
			stripUnclaimedInteractionMarkup("Go:\n[CHOICE:a]\nnavigate:/home=Home\n"),
		).toBe("Go:");
	});

	it("stops stripping at an option line with an unknown command prefix", () => {
		const text = "Go:\n[CHOICE:a]\nweird:y=Z\n";
		expect(stripUnclaimedInteractionMarkup(text)).toBe(text);
	});

	it("does not strip a closer-only suffix", () => {
		const text = "Answer.\n[/CHOICE]\nx=X\n";
		expect(stripUnclaimedInteractionMarkup(text)).toBe(text);
	});
});

describe("parseInteractionBlocks", () => {
	it("passes plain text through with no blocks", () => {
		const parsed = parseInteractionBlocks("Hello there, friend.");
		expect(parsed.blocks).toEqual([]);
		expect(parsed.cleanedText).toBe("Hello there, friend.");
	});

	it("removes a single claimed block and tidies surrounding whitespace", () => {
		const parsed = parseInteractionBlocks(
			"Pick one:\n[CHOICE:a]\nx=X\n[/CHOICE]",
		);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.blocks[0].kind).toBe("choice");
		expect(parsed.cleanedText).toBe("Pick one:");
	});

	it("joins prose around multiple blocks and preserves paragraph breaks", () => {
		const parsed = parseInteractionBlocks(
			"A\n[CHOICE:s1]\nx=1\n[/CHOICE]\nmid\n[FOLLOWUPS id=f]\nr:p=P\n[/FOLLOWUPS]\nB",
		);
		expect(parsed.blocks.map((b) => b.kind)).toEqual(["choice", "followups"]);
		expect(parsed.cleanedText).toBe("A\n\nmid\n\nB");
	});

	it("removes an inline task while preserving sentence spacing", () => {
		const parsed = parseInteractionBlocks(
			"Do it [TASK:a1b2c3d4]Fix login[/TASK] now",
		);
		expect(parsed.blocks).toHaveLength(1);
		expect((parsed.blocks[0] as TaskInteraction).title).toBe("Fix login");
		expect(parsed.cleanedText).toBe("Do it  now");
	});

	it("preserves malformed FORM residue next to a valid block", () => {
		const parsed = parseInteractionBlocks(
			"A\n[FORM]\nnot json\n[/FORM]\n[CHOICE:a]\nx=X\n[/CHOICE]",
		);
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.blocks[0].kind).toBe("choice");
		expect(parsed.cleanedText).toBe("A\n[FORM]\nnot json\n[/FORM]");
	});
});
