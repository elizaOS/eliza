import { describe, expect, it } from "vitest";
import { parseKeyValueXml } from "../utils";

describe("parseKeyValueXml", () => {
	it("parses TOON responses for legacy callers", () => {
		const parsed = parseKeyValueXml(`Here is the result:

TOON
contactName: David
entityId:
message: hello`);

		expect(parsed).toEqual({
			contactName: "David",
			entityId: "",
			message: "hello",
		});
	});

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
