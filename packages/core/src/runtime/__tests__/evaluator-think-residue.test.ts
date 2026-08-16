/**
 * Matrix F18 (tj-b8809c9841cdfd, SEVERE): the evaluator model emitted a
 * think-token-prefixed fenced envelope — `None</think>```json {…}` — which
 * defeated fence unwrap, strict parse, AND the leading-fence repair, so the
 * raw envelope became messageToUser and reached Discord verbatim. Seam 1:
 * the parser strips everything through the last </think> before envelope
 * handling. (Seam 2, the egress rejection, is pinned in the planner-loop
 * suite via isUnsafeUserVisibleText's exported behavior.)
 */
import { describe, expect, it } from "vitest";
import { parseEvaluatorOutput } from "../evaluator";

const F18_RAW =
	'None</think>```json\n{ "success": true, "decision": "FINISH", "thought": "Documents store is empty.", "messageToUser": "Your documents store is empty." }\n```';

describe("evaluator think-residue stripping (F18)", () => {
	it("parses the live think-prefixed envelope instead of leaking it", () => {
		const output = parseEvaluatorOutput(F18_RAW);
		expect(output.parseError).toBeUndefined();
		expect(output.decision).toBe("FINISH");
		expect(output.messageToUser).toBe("Your documents store is empty.");
	});

	it("still parses plain fenced envelopes", () => {
		const output = parseEvaluatorOutput(
			'```json\n{ "success": true, "decision": "FINISH", "thought": "queue drained", "messageToUser": "All finished with the review." }\n```',
		);
		expect(output.parseError).toBeUndefined();
		expect(output.messageToUser).toBe("All finished with the review.");
	});
});

import { isUnsafeUserVisibleText } from "../planner-loop";

describe("egress rejection of internals (F18 seam 2)", () => {
	it("rejects think residue and evaluator envelopes at the last line", () => {
		expect(isUnsafeUserVisibleText(F18_RAW)).toBe(true);
		expect(isUnsafeUserVisibleText("prefix</think>anything")).toBe(true);
		expect(
			isUnsafeUserVisibleText(
				'{ "success": false, "decision": "CONTINUE", "thought": "…" }',
			),
		).toBe(true);
	});

	it("passes ordinary prose that merely mentions the words", () => {
		expect(
			isUnsafeUserVisibleText(
				"I think the decision to finish early was a success.",
			),
		).toBe(false);
	});
});
