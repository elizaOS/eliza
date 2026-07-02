import { describe, expect, it } from "vitest";
import { parseKeyValueXml } from "../utils";

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
});
