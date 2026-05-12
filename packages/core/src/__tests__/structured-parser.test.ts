import { describe, expect, it } from "vitest";
import { parseKeyValueXml } from "../utils";

describe("parseKeyValueXml", () => {
	it("parses XML response blocks", () => {
		const parsed = parseKeyValueXml(`
<response>
  <message>Hello &amp; bye</message>
  <simple>true</simple>
  <actions>send, reply</actions>
</response>`);

		expect(parsed).toEqual({
			message: "Hello & bye",
			simple: true,
			actions: ["send", "reply"],
		});
	});
});
