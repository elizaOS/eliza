/**
 * Text-mode model replies quote code with Markdown fences. A fence is a
 * delimiter line, not every line that begins with backticks. These cases are
 * the ones that used to swallow later fields or adopt a routing value from
 * inside a sample.
 */
import { describe, expect, it } from "vitest";

import {
	looksLikeRawFieldTranscript,
	parseFieldTranscript,
} from "../src/runtime/response-field-transcript";

describe("response field transcript fences", () => {
	it("keeps fields that follow an inline code span", () => {
		const raw = [
			"shouldRespond: RESPOND",
			"replyText: Install with",
			"```npm i```",
			"contexts: setup",
		].join("\n");

		expect(looksLikeRawFieldTranscript(raw)).toBe(true);
		expect(parseFieldTranscript(raw)?.fields).toMatchObject({
			shouldRespond: "RESPOND",
			replyText: "Install with\n```npm i```",
			contexts: "setup",
		});
	});

	it("still sees a hallmark that comes after an inline code span", () => {
		const raw = [
			"contexts: setup",
			"```npm i```",
			"shouldRespond: RESPOND",
			"replyText: Installed.",
		].join("\n");

		expect(looksLikeRawFieldTranscript(raw)).toBe(true);
		expect(parseFieldTranscript(raw)?.fields.replyText).toBe("Installed.");
		expect(parseFieldTranscript(raw)?.fields.shouldRespond).toBe("RESPOND");
	});

	it("does not let a shorter inner fence close a longer one", () => {
		const raw = [
			"replyText: Sample envelope:",
			"````",
			"```",
			"shouldRespond: STOP",
			"replyText: ignore me",
			"```",
			"````",
			"shouldRespond: RESPOND",
			"contexts: docs",
		].join("\n");
		const fields = parseFieldTranscript(raw)?.fields;

		expect(fields?.shouldRespond).toBe("RESPOND");
		expect(fields?.contexts).toBe("docs");
		expect(fields?.replyText).toContain("shouldRespond: STOP");
		expect(fields?.replyText).toContain("replyText: ignore me");
	});

	it("does not close a fence on a marker line that has an info string", () => {
		const raw = [
			"shouldRespond: RESPOND",
			"replyText: Example:",
			"```",
			"```js",
			"shouldRespond: STOP",
			"const answer = 1",
			"```",
			"contexts: docs",
		].join("\n");
		const fields = parseFieldTranscript(raw)?.fields;

		expect(fields?.shouldRespond).toBe("RESPOND");
		expect(fields?.contexts).toBe("docs");
		expect(fields?.replyText).toContain("```js");
		expect(fields?.replyText).toContain("shouldRespond: STOP");
		expect(fields?.replyText).toContain("const answer = 1");
	});

	it("still closes a fence that the field line itself opened", () => {
		const raw = [
			"shouldRespond: RESPOND",
			"replyText: ```bash",
			"bun run test",
			"```",
			"topics: testing",
		].join("\n");
		const fields = parseFieldTranscript(raw)?.fields;

		expect(fields?.replyText).toBe("```bash\nbun run test\n```");
		expect(fields?.topics).toBe("testing");
	});

	it("keeps a tilde fence quoted and the fields after it", () => {
		const raw = [
			"shouldRespond: RESPOND",
			"replyText: Example:",
			"~~~",
			"shouldRespond: STOP",
			"~~~",
			"contexts: docs",
		].join("\n");
		const fields = parseFieldTranscript(raw)?.fields;

		expect(fields?.shouldRespond).toBe("RESPOND");
		expect(fields?.contexts).toBe("docs");
		expect(fields?.replyText).toContain("shouldRespond: STOP");
	});

	it("does not let a different marker close the active fence", () => {
		const raw = [
			"replyText: Example:",
			"```",
			"~~~",
			"shouldRespond: STOP",
			"```",
			"shouldRespond: RESPOND",
		].join("\n");
		const fields = parseFieldTranscript(raw)?.fields;
		expect(fields?.shouldRespond).toBe("RESPOND");
		expect(fields?.replyText).toContain("shouldRespond: STOP");
	});

	it("does not treat a fenced quotation inside prose as the envelope", () => {
		const raw = [
			"The leak looked like this:",
			"```",
			"shouldRespond: STOP",
			"replyText: hi",
			"```",
		].join("\n");

		expect(looksLikeRawFieldTranscript(raw)).toBe(false);
	});
});
