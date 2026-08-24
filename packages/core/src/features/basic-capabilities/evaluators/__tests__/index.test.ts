/**
 * Unit coverage for the basic-capabilities inbound evaluators barrel
 * (`evaluators/index.ts`): the `basicCapabilitiesEvaluators` collection the
 * runtime evaluator registry consumes and the fidelity of the
 * `linkExtractionEvaluator` re-export (one shared instance across import
 * paths). The harness is fully deterministic — `shouldRun` is driven through
 * the exported array over plain message text, so no network, model, or
 * database is touched. Evaluator internals are covered by
 * `./link-extraction.test.ts`; only the wiring is proven here.
 */
import { describe, expect, it } from "vitest";
import type { EvaluatorRunContext, Memory } from "../../../../types/index.ts";
import {
	basicCapabilitiesEvaluators,
	linkExtractionEvaluator as reExportedLinkExtraction,
} from "../index.ts";
import { linkExtractionEvaluator } from "../link-extraction.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ENTITY_ID = "00000000-0000-0000-0000-000000000002";
const ROOM_ID = "00000000-0000-0000-0000-000000000003";

function makeMessage(content: Memory["content"]): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000aa",
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content,
		createdAt: Date.now(),
	} as Memory;
}

function makeContext(message: Memory): EvaluatorRunContext {
	return {
		runtime: {} as EvaluatorRunContext["runtime"],
		message,
		options: {},
	};
}

describe("basicCapabilitiesEvaluators barrel", () => {
	it("registers the link-extraction evaluator instance, not a copy", () => {
		expect(Array.isArray(basicCapabilitiesEvaluators)).toBe(true);
		expect(basicCapabilitiesEvaluators).toHaveLength(1);
		expect(basicCapabilitiesEvaluators[0]).toBe(linkExtractionEvaluator);
	});

	it("re-exports the same linkExtractionEvaluator instance as the source module", () => {
		expect(reExportedLinkExtraction).toBe(linkExtractionEvaluator);
	});

	it("exposes registry-consumable evaluators with unique string names", () => {
		expect(basicCapabilitiesEvaluators.length).toBeGreaterThan(0);
		const names = basicCapabilitiesEvaluators.map(
			(evaluator) => evaluator.name,
		);
		for (const name of names) {
			expect(typeof name).toBe("string");
			expect(name.length).toBeGreaterThan(0);
		}
		expect(new Set(names).size).toBe(names.length);
		for (const evaluator of basicCapabilitiesEvaluators) {
			expect(typeof evaluator.shouldRun).toBe("function");
			expect(typeof evaluator.prompt).toBe("function");
			expect(evaluator.schema).toEqual(
				expect.objectContaining({ type: "object" }),
			);
		}
	});

	it("runs the registered URL gate through the exported array", async () => {
		const [registered] = basicCapabilitiesEvaluators;
		await expect(
			registered.shouldRun(
				makeContext(makeMessage({ text: "read https://example.com/post now" })),
			),
		).resolves.toBe(true);
		await expect(
			registered.shouldRun(
				makeContext(makeMessage({ text: "no links in this message" })),
			),
		).resolves.toBe(false);
	});

	it("treats empty or textless content as no-link through the array", async () => {
		const [registered] = basicCapabilitiesEvaluators;
		await expect(
			registered.shouldRun(makeContext(makeMessage({ text: "" }))),
		).resolves.toBe(false);
		await expect(
			registered.shouldRun(makeContext(makeMessage({}))),
		).resolves.toBe(false);
	});
});
