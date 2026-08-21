/** Exercises whole-fence parsing at the lenient model JSON boundary. */

import { describe, expect, it } from "vitest";
import { parseJsonModelOutput } from "./json-model-output.ts";

describe("parseJsonModelOutput", () => {
	it("parses compact unlabeled fenced JSON scalars", () => {
		expect(parseJsonModelOutput("```true```")).toBe(true);
	});
});
