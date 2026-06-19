/**
 * World Facts Consolidator Unit Tests
 *
 * Tests the clustering and consolidation logic. Since the consolidator
 * requires DB access and LLM calls for full execution, we test the
 * exported class structure and verify the service can be instantiated.
 *
 * Full integration testing of the consolidation pipeline should be done
 * via the /api/cron/world-facts route in integration tests.
 */

import { describe, expect, test } from "bun:test";
import { WorldFactsConsolidator } from "@feed/engine";

describe("WorldFactsConsolidator", () => {
  test("can be instantiated with a mock LLM client", () => {
    // Verify the class is exported and constructible
    const mockLlm = {
      generateJSON: async () => ({ consolidatedFact: "test" }),
    };

    // The constructor accepts a FeedLLMClient — verify it doesn't throw
    // with a minimal mock (type coercion for unit test purposes)
    const consolidator = new WorldFactsConsolidator(mockLlm as never);
    expect(consolidator).toBeDefined();
    expect(typeof consolidator.consolidateFacts).toBe("function");
  });

  test("exports the expected interface", () => {
    // Verify WorldFactsConsolidator has the expected public API
    expect(WorldFactsConsolidator).toBeDefined();
    expect(typeof WorldFactsConsolidator).toBe("function");

    // Check prototype methods
    expect(typeof WorldFactsConsolidator.prototype.consolidateFacts).toBe(
      "function",
    );
  });
});
