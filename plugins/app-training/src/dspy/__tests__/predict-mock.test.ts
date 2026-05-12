/**
 * Predict.forward + MockAdapter — no-network round-trip through Signature
 * render → LM call → parse.
 */

import { describe, expect, it } from "vitest";
import { MockAdapter } from "../lm-adapter.js";
import { Predict } from "../predict.js";
import { defineSignature } from "../signature.js";

describe("Predict with MockAdapter", () => {
	it("renders a prompt, calls the mock LM, and parses the canned response", async () => {
		const sig = defineSignature<{ input: string }, { output: string }>({
			name: "echo",
			instructions: "Echo the input back as output.",
			inputs: [{ name: "input", description: "Input text.", type: "string" }],
			outputs: [
				{ name: "output", description: "Echoed text.", type: "string" },
			],
		});

		const log: Array<{ system: string; user: string }> = [];
		const lm = new MockAdapter({
			rules: [
				{
					user: "hello world",
					response: "output: hello world",
				},
			],
		});

		const predict = new Predict({ signature: sig, lm });
		const result = await predict.forward({ input: "hello world" });

		expect(result.output.output).toBe("hello world");
		expect(result.trace.demonstrationCount).toBe(0);
		expect(result.trace.rawResponse).toBe("output: hello world");
		void log;
	});

	it("attaches demonstrations to the rendered system block", async () => {
		const sig = defineSignature<{ q: string }, { a: string }>({
			name: "demoed",
			instructions: "Answer the question.",
			inputs: [{ name: "q", description: "question", type: "string" }],
			outputs: [{ name: "a", description: "answer", type: "string" }],
		});
		const lm = new MockAdapter({ defaultResponse: "a: forty two" });

		const predict = new Predict({
			signature: sig,
			lm,
			demonstrations: [
				{ inputs: { q: "what is 6*7" }, outputs: { a: "42" } },
				{ inputs: { q: "what is 8*5" }, outputs: { a: "40" } },
			],
		});
		const result = await predict.forward({ q: "what is 2*21" });
		expect(result.trace.demonstrationCount).toBe(2);
		expect(result.trace.system).toContain("Demonstrations:");
		expect(result.output.a).toBe("forty two");
	});
});
