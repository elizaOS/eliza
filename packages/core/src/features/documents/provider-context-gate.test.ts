/**
 * Pins the DOCUMENTS provider's exact context selection against the runtime's
 * real context gate and registry. Parent/child context relationships are
 * metadata, not implicit provider expansion.
 */
import { describe, expect, it } from "vitest";
import { filterByContextGate } from "../../runtime/context-gates.ts";
import { getDefaultContextDefinitions } from "../../runtime/default-contexts.ts";
import type { AgentContext } from "../../types/index.ts";
import { documentsProvider } from "./provider.ts";

function selectsDocuments(activeContexts: AgentContext[]): boolean {
	return (
		filterByContextGate([documentsProvider], activeContexts, ["USER"])
			.length === 1
	);
}

describe("DOCUMENTS provider context gating", () => {
	it("keeps knowledge registered as a documents subcontext", () => {
		const knowledge = getDefaultContextDefinitions().find(
			(context) => context.id === "knowledge",
		);
		expect(knowledge?.parent).toBe("documents");
	});

	it("selects both exact stored-document contexts", () => {
		expect(selectsDocuments(["documents"])).toBe(true);
		expect(selectsDocuments(["knowledge"])).toBe(true);
		expect(selectsDocuments(["simple", "knowledge"])).toBe(true);
	});

	it("does not expand into unrelated contexts", () => {
		expect(selectsDocuments(["simple"])).toBe(false);
		expect(selectsDocuments(["wallet"])).toBe(false);
	});
});
