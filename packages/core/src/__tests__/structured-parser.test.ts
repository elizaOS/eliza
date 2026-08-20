/**
 * Unit tests for `parseKeyValueXml`: `<response>` block parsing and the
 * prefix-extended-tag regression where a nested `<textarea>` inside `<text>`
 * must not inflate close-tag matching. Deterministic parser test.
 */
import { describe, expect, it } from "vitest";
import { parseKeyValueXml } from "../utils";

const XML_CLOSE_VISIT_LIMIT = 64;

describe("parseKeyValueXml", () => {
	it("parses XML response blocks", () => {
		const parsed = parseKeyValueXml(`
<response>
  <message>Hello &amp; bye</message>
  <actions>send, reply</actions>
</response>`);

		expect(parsed).toEqual({
			message: "Hello & bye",
			actions: ["send", "reply"],
		});
	});

	it("does not treat a prefix-extended tag in a value as a nested open", () => {
		// Regression: findMatchingXmlClose matched any tag STARTING with the name
		// (`<textarea>` while closing `<text>`), inflating depth so the close was
		// never found — the field was dropped and a bogus key promoted.
		const parsed = parseKeyValueXml(
			`<response><text>see <textarea>x</textarea> ok</text><thought>t</thought></response>`,
		);
		expect(parsed).toEqual({
			text: "see <textarea>x</textarea> ok",
			thought: "t",
		});
	});

	it("fails closed on a prefix-extension bomb instead of quadratic-hanging", () => {
		const inner = `<a>${"<aa></aa>".repeat(20_000)}x</a>`;
		const t0 = performance.now();
		parseKeyValueXml(`<response>${inner}</response>`);
		expect(performance.now() - t0).toBeLessThan(50);
	});

	it("parses the direct-child visit limit and rejects one more", () => {
		const fields = Array.from(
			{ length: XML_CLOSE_VISIT_LIMIT },
			(_, i) => `<f${i}>v${i}</f${i}>`,
		).join("");
		const parsed = parseKeyValueXml(`<response>${fields}</response>`);
		expect(parsed).not.toBeNull();
		expect(Object.keys(parsed ?? {})).toHaveLength(XML_CLOSE_VISIT_LIMIT);

		const overflow = `${fields}<extra>x</extra>`;
		expect(parseKeyValueXml(`<response>${overflow}</response>`)).toBeNull();
	});
});
