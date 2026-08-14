/**
 * Pins which agent contexts select the DOCUMENTS provider, using the real
 * `filterByContextGate` and the real default context registry — no mocks.
 *
 * `knowledge` is declared as a subcontext of `documents`, but gate matching is
 * exact set membership with no parent expansion, so a provider that only
 * declares `documents` is skipped on the turns Stage-1 routes to `knowledge`
 * ("answer from stored knowledge/RAG") — the turns baked-in character knowledge
 * exists to answer.
 */
import { describe, expect, it } from "vitest";
import { filterByContextGate } from "../../runtime/context-gates.ts";
import { getDefaultContextDefinitions } from "../../runtime/default-contexts.ts";
import type { AgentContext } from "../../types";
import { documentsProvider } from "./provider.ts";

function selectsDocuments(activeContexts: AgentContext[]): boolean {
	return (
		filterByContextGate([documentsProvider], activeContexts, ["USER"])
			.length === 1
	);
}

describe("DOCUMENTS provider context gating", () => {
	it("keeps knowledge as a subcontext of documents (registry premise)", () => {
		const contexts = getDefaultContextDefinitions();
		const knowledge = contexts.find((context) => context.id === "knowledge");
		expect(knowledge?.parent).toBe("documents");
	});

	it("selects the provider for the documents context", () => {
		expect(selectsDocuments(["documents"])).toBe(true);
	});

	it("selects the provider for the knowledge context", () => {
		expect(selectsDocuments(["knowledge"])).toBe(true);
	});

	it("selects the provider when knowledge is one of several active contexts", () => {
		expect(selectsDocuments(["simple", "knowledge"])).toBe(true);
	});

	it("skips the provider for contexts that are not about stored knowledge", () => {
		expect(selectsDocuments(["simple"])).toBe(false);
		expect(selectsDocuments(["wallet"])).toBe(false);
	});
});
