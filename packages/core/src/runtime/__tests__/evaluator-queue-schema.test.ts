/** Verifies completion output schemas against real queue construction with a captured model boundary. */
import { describe, expect, it } from "vitest";
import {
	evaluatorSchema,
	evaluatorTemplate,
	evaluatorTemplateForQueue,
} from "../../prompts/evaluator";
import type { JSONSchema } from "../../types/model";
import { runEvaluator } from "../evaluator";
import type { PlannerToolCall, PlannerTrajectory } from "../planner-types";

async function captureSchema(
	plannedQueue: PlannerToolCall[],
	redactSecrets = (text: string) => text,
) {
	let schema: JSONSchema | undefined;
	let messages = "";
	const trajectory: PlannerTrajectory = {
		context: { id: "queue-contract" },
		steps: [],
		plannedQueue,
		evaluatorOutputs: [],
	};
	const before = structuredClone(trajectory);
	await runEvaluator({
		runtime: {
			redactSecrets,
			useModel: async (_type, options) => {
				schema = options.responseSchema as JSONSchema;
				messages = JSON.stringify(options.messages);
				return JSON.stringify({
					thought: "More work needs planning.",
					success: false,
					decision: "CONTINUE",
				});
			},
		},
		context: trajectory.context,
		trajectory,
	});
	expect(trajectory).toEqual(before);
	return { schema, messages };
}

it("keeps every non-queue instruction unchanged", () => {
	const full = evaluatorTemplateForQueue(true);
	const empty = evaluatorTemplateForQueue(false);
	expect(full).toBe(evaluatorTemplate);
	expect(empty.length).toBeLessThan(full.length);
	for (const line of full.split("\n")) {
		if (!line.includes("NEXT_RECOMMENDED"))
			expect(empty.split("\n")).toContain(line);
	}
});

describe("completion recommendations describe the current planner queue", () => {
	it("does not advertise a queued-call decision when no calls remain", async () => {
		const { schema, messages } = await captureSchema([]);
		expect(schema?.properties?.decision.enum).toEqual(["FINISH", "CONTINUE"]);
		expect(schema?.properties).not.toHaveProperty("recommendedToolCallId");
		expect(schema?.additionalProperties).toBe(false);
		expect(messages).not.toContain("NEXT_RECOMMENDED");
		expect(messages).toContain("No executable calls remain queued");
		expect(messages).toContain("more_work_pending");
		expect(messages).toContain("effectReceiptIds");
	});

	it("distinguishes two calls to the same tool by their exact queue IDs", async () => {
		const { schema, messages } = await captureSchema([
			{ id: "read-left", name: "NOTES_GET", params: { noteId: "left" } },
			{ id: "read-right", name: "NOTES_GET", params: { noteId: "right" } },
		]);
		expect(schema?.properties?.decision.enum).toEqual([
			"FINISH",
			"NEXT_RECOMMENDED",
			"CONTINUE",
		]);
		expect(messages).toContain(
			"NEXT_RECOMMENDED when the next queued tool remains grounded",
		);
		expect(schema?.properties?.recommendedToolCallId.enum).toEqual([
			"read-left",
			"read-right",
		]);
	});

	it("keeps the existing name fallback for callers without generated IDs", async () => {
		const { schema } = await captureSchema([
			{ name: "LOOKUP", params: {} },
			{ id: "next-call", name: "LOOKUP", params: {} },
		]);
		expect(schema?.properties?.recommendedToolCallId.enum).toEqual([
			"LOOKUP",
			"next-call",
		]);
	});

	it("does not disclose redacted queue IDs through schema enums", async () => {
		const { schema, messages } = await captureSchema(
			[{ id: "private-call-id", name: "LOOKUP", params: {} }],
			(text) => text.replaceAll("private-call-id", "[REDACTED]"),
		);
		expect(JSON.stringify(schema)).not.toContain("private-call-id");
		expect(messages).not.toContain("NEXT_RECOMMENDED");
		expect(schema?.properties?.decision.enum).toEqual(["FINISH", "CONTINUE"]);
	});

	it("does not mutate the reusable canonical schema across turns", async () => {
		const original = structuredClone(evaluatorSchema);
		await captureSchema([{ id: "one", name: "LOOKUP", params: {} }]);
		await captureSchema([]);
		expect(evaluatorSchema).toEqual(original);
	});
});
