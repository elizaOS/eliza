/**
 * Verifies resolveProviderContexts (context-catalog) surfaces the ACTION_STATE
 * provider in every first-party context. Vitest, direct function calls.
 */

import { describe, expect, it } from "vitest";
import { actionStateProvider } from "../features/basic-capabilities/providers/actionState";
import { FIRST_PARTY_CONTEXT_IDS } from "../runtime/context-normalization";
import { resolveProviderContexts } from "./context-catalog";

describe("resolveProviderContexts", () => {
	it("exposes ACTION_STATE in every first-party context", () => {
		expect(resolveProviderContexts(actionStateProvider)).toEqual([
			...FIRST_PARTY_CONTEXT_IDS,
		]);
		expect(resolveProviderContexts(actionStateProvider)).toContain("tasks");
		expect(resolveProviderContexts(actionStateProvider)).toContain("code");
		expect(resolveProviderContexts(actionStateProvider)).toContain(
			"agent_internal",
		);
	});
});
