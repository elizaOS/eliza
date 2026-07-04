/**
 * Unit coverage for the text-mode response-field transcript parser
 * (`parseFieldTranscript`, `extractReplyTextFromTranscript`,
 * `looksLikeRawFieldTranscript`, `splitTranscriptList`) and the message-handler
 * fallback that recovers a clean reply from a leaked `shouldRespond:/replyText:`
 * envelope. Driven by deterministic string fixtures (the exact #11712 leak,
 * plus quoting/fenced counter-examples); no model.
 */
import { describe, expect, it } from "vitest";
import { parseMessageHandlerOutput } from "../message-handler";
import {
	extractReplyTextFromTranscript,
	looksLikeRawFieldTranscript,
	parseFieldTranscript,
	splitTranscriptList,
} from "../response-field-transcript";

// The EXACT leaked transcript from issue #11712 (round-5 discord test). The
// replyText value spans multiple lines with an embedded blank line between the
// URL line and the "built it out..." line — the prime segmentation killer.
const LEAKED_TRANSCRIPT = `shouldRespond: RESPOND

replyText: it's live ☀️ https://sol.shad0w.xyz/apps/aurora/

built it out at /workspace/apps, aurora's got the modern design + interactive bits you asked for. go click around and tell me what's ugly.

contexts: simple

topics: website build, aurora

emotion: none`;

const EXPECTED_REPLY = `it's live ☀️ https://sol.shad0w.xyz/apps/aurora/

built it out at /workspace/apps, aurora's got the modern design + interactive bits you asked for. go click around and tell me what's ugly.`;

describe("response field transcript — parseFieldTranscript", () => {
	it("segments the exact leaked #11712 transcript, preserving the multi-line replyText with its embedded blank line, URL, and emoji", () => {
		const parsed = parseFieldTranscript(LEAKED_TRANSCRIPT);
		expect(parsed).not.toBeNull();
		expect(parsed?.fields.shouldRespond).toBe("RESPOND");
		expect(parsed?.fields.replyText).toBe(EXPECTED_REPLY);
		// The value keeps the embedded blank line, the ☀️ emoji, and the URL.
		expect(parsed?.fields.replyText).toContain("☀️");
		expect(parsed?.fields.replyText).toContain(
			"https://sol.shad0w.xyz/apps/aurora/",
		);
		expect(parsed?.fields.replyText).toContain("\n\n");
		expect(parsed?.fields.contexts).toBe("simple");
		expect(parsed?.fields.topics).toBe("website build, aurora");
		expect(parsed?.fields.emotion).toBe("none");
	});

	it("terminates a field value only at the next known-field line, not at a blank line", () => {
		const t = `replyText: line one

line two after a blank

line three

contexts: simple`;
		const parsed = parseFieldTranscript(t);
		expect(parsed?.fields.replyText).toBe(
			"line one\n\nline two after a blank\n\nline three",
		);
		expect(parsed?.fields.contexts).toBe("simple");
	});

	it("does not split on a colon that appears inside a value (e.g. a ratio)", () => {
		const t = `replyText: the ratio is 3:1 and the time is 10:30

contexts: simple`;
		const parsed = parseFieldTranscript(t);
		expect(parsed?.fields.replyText).toBe(
			"the ratio is 3:1 and the time is 10:30",
		);
		expect(parsed?.fields.contexts).toBe("simple");
	});

	it("returns null when there are no known field lines (plain prose)", () => {
		expect(
			parseFieldTranscript("just a normal reply, nothing keyed"),
		).toBeNull();
		expect(parseFieldTranscript("")).toBeNull();
		expect(parseFieldTranscript(null)).toBeNull();
	});

	it("first occurrence of a field wins (de-dup)", () => {
		const t = `replyText: first

replyText: second`;
		const parsed = parseFieldTranscript(t);
		expect(parsed?.fields.replyText).toBe("first");
	});
});

describe("response field transcript — extractReplyTextFromTranscript", () => {
	it("recovers the intended reply from the leaked transcript", () => {
		expect(extractReplyTextFromTranscript(LEAKED_TRANSCRIPT)).toBe(
			EXPECTED_REPLY,
		);
	});

	it("returns null for non-transcript prose and for empty replyText", () => {
		expect(extractReplyTextFromTranscript("hi there")).toBeNull();
		expect(
			extractReplyTextFromTranscript("shouldRespond: RESPOND\n\nreplyText: "),
		).toBeNull();
	});
});

describe("response field transcript — looksLikeRawFieldTranscript (send-boundary guard)", () => {
	it("flags text that leads with shouldRespond:", () => {
		expect(looksLikeRawFieldTranscript(LEAKED_TRANSCRIPT)).toBe(true);
		expect(looksLikeRawFieldTranscript("shouldRespond: IGNORE")).toBe(true);
	});

	it("flags text that leads with replyText: (reply-bearing echo without routing field)", () => {
		expect(looksLikeRawFieldTranscript("replyText: hello")).toBe(true);
		expect(looksLikeRawFieldTranscript("\n\n  replyText: hello")).toBe(true);
	});

	it("flags an echo that leads with a secondary field before the hallmark", () => {
		expect(
			looksLikeRawFieldTranscript("contexts: simple\nreplyText: hello"),
		).toBe(true);
	});

	it("does NOT flag normal replies without field markers", () => {
		expect(looksLikeRawFieldTranscript("it's live ☀️ go check it out")).toBe(
			false,
		);
		expect(
			looksLikeRawFieldTranscript(
				"Here is the plan:\n1. do a thing\n2. do another thing",
			),
		).toBe(false);
		expect(looksLikeRawFieldTranscript("")).toBe(false);
		expect(looksLikeRawFieldTranscript(null)).toBe(false);
	});
});

// A reply that QUOTES a transcript is content, not a leak. This repo's own
// daily workflow: a user pastes a leaked `shouldRespond:/replyText:` transcript
// into chat and asks the bot to diagnose it. The diagnosis legitimately carries
// quoted field lines; the guard must not rewrite it — otherwise the send
// boundary would replace the whole diagnosis with the QUOTED replyText value,
// silently dropping the actual answer.
const QUOTING_DIAGNOSIS = `the bug is in your parser — when the model emits:

shouldRespond: RESPOND

replyText: it works

the blank line inside the value is where naive blank-line segmentation breaks. terminate values only at the next known-field line.`;

const FENCED_QUOTING_DIAGNOSIS = `here's the transcript that leaked:

\`\`\`
shouldRespond: RESPOND

replyText: it works
\`\`\`

that skeleton is the raw HANDLE_RESPONSE envelope — your text-mode provider echoed the field set instead of JSON.`;

describe("response field transcript — replies that QUOTE a transcript are not leaks", () => {
	it("does NOT flag a diagnosis that opens with prose and quotes field lines", () => {
		expect(looksLikeRawFieldTranscript(QUOTING_DIAGNOSIS)).toBe(false);
	});

	it("does NOT flag a reply whose quoted transcript sits inside a code fence", () => {
		expect(looksLikeRawFieldTranscript(FENCED_QUOTING_DIAGNOSIS)).toBe(false);
	});

	it("does NOT flag a reply that LEADS with a fenced transcript quote", () => {
		expect(
			looksLikeRawFieldTranscript(
				"```\nshouldRespond: RESPOND\nreplyText: hi\n```\nthat's the leak — fence it off in your parser.",
			),
		).toBe(false);
	});

	it("still flags the genuine leak even when its replyText mentions a fence", () => {
		expect(
			looksLikeRawFieldTranscript(
				"shouldRespond: RESPOND\n\nreplyText: wrap it in ``` fences",
			),
		).toBe(true);
	});

	it("parseMessageHandlerOutput does NOT claim quoting prose (falls through with preamble intact)", () => {
		// Claiming it would drop every line before the quoted `replyText:` and
		// ship only the quote's tail ("it works\n\nthe blank line…").
		expect(parseMessageHandlerOutput(QUOTING_DIAGNOSIS)).toBeNull();
		expect(parseMessageHandlerOutput(FENCED_QUOTING_DIAGNOSIS)).toBeNull();
	});

	it("extractReplyTextFromTranscript is never consulted for quoting prose at the send boundary (guard=false), preserving the diagnosis", () => {
		// The send boundary only rewrites when looksLikeRawFieldTranscript is
		// true; assert the exact guard predicate the boundary uses.
		expect(looksLikeRawFieldTranscript(QUOTING_DIAGNOSIS)).toBe(false);
		expect(looksLikeRawFieldTranscript(FENCED_QUOTING_DIAGNOSIS)).toBe(false);
	});
});

describe("response field transcript — fenced field lines never split a value", () => {
	it("keeps a fenced quoted transcript inside the replyText value of a REAL leak", () => {
		// Text-mode echo whose replyText value itself quotes an envelope inside a
		// code fence (the bot diagnosing a transcript, answered in text mode).
		// The fenced `contexts:`/`replyText:` lines are content — the value must
		// terminate only at the next UNFENCED known-field line (`emotion:`).
		const t = `shouldRespond: RESPOND

replyText: the parser bug is here:

\`\`\`
contexts: simple
replyText: it works
\`\`\`

fields split only at unfenced field lines.

emotion: none`;
		const parsed = parseFieldTranscript(t);
		expect(parsed?.fields.shouldRespond).toBe("RESPOND");
		expect(parsed?.fields.replyText).toContain("the parser bug is here:");
		expect(parsed?.fields.replyText).toContain("contexts: simple");
		expect(parsed?.fields.replyText).toContain(
			"fields split only at unfenced field lines.",
		);
		// The fenced `contexts:` line did NOT open a contexts field.
		expect(parsed?.fields.contexts).toBeUndefined();
		expect(parsed?.fields.emotion).toBe("none");
	});
});

describe("response field transcript — splitTranscriptList", () => {
	it("splits comma- and newline-separated values, collapsing none/empty", () => {
		expect(splitTranscriptList("website build, aurora")).toEqual([
			"website build",
			"aurora",
		]);
		expect(splitTranscriptList("simple")).toEqual(["simple"]);
		expect(splitTranscriptList("none")).toEqual([]);
		expect(splitTranscriptList("")).toEqual([]);
		expect(splitTranscriptList(undefined)).toEqual([]);
	});
});

describe("parseMessageHandlerOutput — text-mode transcript path (#11712)", () => {
	it("parses the exact leaked transcript to the correct replyText instead of falling through as raw", () => {
		const result = parseMessageHandlerOutput(LEAKED_TRANSCRIPT);
		expect(result).not.toBeNull();
		expect(result?.processMessage).toBe("RESPOND");
		expect(result?.plan.reply).toBe(EXPECTED_REPLY);
		// It must NOT be the raw transcript.
		expect(result?.plan.reply).not.toContain("shouldRespond:");
		expect(result?.plan.contexts).toEqual(["simple"]);
		expect(result?.extract?.topics).toEqual(["website build", "aurora"]);
	});

	it("still returns the canonical JSON parse for JSON input (untouched)", () => {
		const json = JSON.stringify({
			shouldRespond: "RESPOND",
			replyText: "plain json reply",
			contexts: ["simple"],
		});
		const result = parseMessageHandlerOutput(json);
		expect(result?.plan.reply).toBe("plain json reply");
		expect(result?.plan.contexts).toEqual(["simple"]);
	});

	it("returns null for plain prose with no field markers (falls through to plain-text handling)", () => {
		expect(parseMessageHandlerOutput("just a normal reply")).toBeNull();
	});
});
