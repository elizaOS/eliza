/**
 * Tests for NPC duplicate position prevention
 *
 * Verifies that NPCs correctly skip opening positions on organizations
 * where they already have open positions.
 */

import { describe, expect, it } from "bun:test";

describe("NPC Duplicate Position Prevention", () => {
  describe("Position Key Generation", () => {
    /**
     * Tests the position key format used to identify existing positions.
     * Key format: `{actorId}:{organizationId.toLowerCase()}`
     */
    it("should generate consistent position keys", () => {
      const generatePositionKey = (actorId: string, orgId: string): string => {
        return `${actorId}:${orgId.toLowerCase()}`;
      };

      expect(generatePositionKey("npc-1", "AAPL")).toBe("npc-1:aapl");
      expect(generatePositionKey("npc-1", "aapl")).toBe("npc-1:aapl");
      expect(generatePositionKey("npc-1", "AaPL")).toBe("npc-1:aapl");
    });

    it("should match regardless of ticker case", () => {
      const existingKeys = new Set(["npc-1:aapl", "npc-2:goog"]);

      // Should match - same actor, same org (different case)
      expect(existingKeys.has(`npc-1:${"AAPL".toLowerCase()}`)).toBe(true);
      expect(existingKeys.has(`npc-1:${"aapl".toLowerCase()}`)).toBe(true);

      // Should not match - different actor
      expect(existingKeys.has(`npc-3:${"aapl".toLowerCase()}`)).toBe(false);

      // Should not match - different org
      expect(existingKeys.has(`npc-1:${"goog".toLowerCase()}`)).toBe(false);
    });
  });

  describe("Allocation Skipping Logic", () => {
    /**
     * Simulates the baseline decision building logic.
     *
     * NOTE: This mirrors the allocation logic in NPCInvestmentManager.buildBaselineDecisions().
     * If that logic changes, this mock should be updated to match.
     * See: packages/engine/src/npc/npc-investment-manager.ts
     */
    function buildMockDecisions(
      targetTickers: string[],
      existingPositionKeys: Set<string>,
      actorId: string,
      investBudget: number,
    ): Array<{ ticker: string; amount: number }> {
      const decisions: Array<{ ticker: string; amount: number }> = [];
      let remainingBudget = investBudget;

      targetTickers.forEach((ticker, index) => {
        // Skip if NPC already has an open position on this organization
        const positionKey = `${actorId}:${ticker.toLowerCase()}`;
        if (existingPositionKeys.has(positionKey)) {
          return;
        }

        const allocationsRemaining = targetTickers.length - index;
        let allocation = remainingBudget / allocationsRemaining;
        allocation = Number(allocation.toFixed(2));

        if (allocation <= 0) {
          return;
        }

        remainingBudget = Math.max(remainingBudget - allocation, 0);

        decisions.push({
          ticker,
          amount: allocation,
        });
      });

      return decisions;
    }

    it("should skip tickers with existing positions", () => {
      const existingKeys = new Set(["npc-1:aapl", "npc-1:goog"]);
      const targetTickers = ["aapl", "goog", "msft", "amzn"];

      const decisions = buildMockDecisions(
        targetTickers,
        existingKeys,
        "npc-1",
        1000,
      );

      // Should only have msft and amzn (aapl and goog were skipped)
      expect(decisions.length).toBe(2);
      expect(decisions.map((d) => d.ticker)).toEqual(["msft", "amzn"]);
    });

    it("should allocate full budget to remaining tickers", () => {
      const existingKeys = new Set(["npc-1:aapl"]);
      const targetTickers = ["aapl", "goog", "msft"];

      const decisions = buildMockDecisions(
        targetTickers,
        existingKeys,
        "npc-1",
        900,
      );

      // 2 decisions (goog, msft) with roughly equal split
      expect(decisions.length).toBe(2);
      const total = decisions.reduce((sum, d) => sum + d.amount, 0);
      expect(total).toBeCloseTo(900, 0);
    });

    it("should return empty when all positions exist", () => {
      const existingKeys = new Set(["npc-1:aapl", "npc-1:goog", "npc-1:msft"]);
      const targetTickers = ["aapl", "goog", "msft"];

      const decisions = buildMockDecisions(
        targetTickers,
        existingKeys,
        "npc-1",
        1000,
      );

      expect(decisions.length).toBe(0);
    });

    it("should handle different actors independently", () => {
      const existingKeys = new Set(["npc-1:aapl", "npc-2:goog"]);
      const targetTickers = ["aapl", "goog", "msft"];

      // npc-1 should skip aapl
      const decisions1 = buildMockDecisions(
        targetTickers,
        existingKeys,
        "npc-1",
        900,
      );
      expect(decisions1.map((d) => d.ticker)).toEqual(["goog", "msft"]);

      // npc-2 should skip goog
      const decisions2 = buildMockDecisions(
        targetTickers,
        existingKeys,
        "npc-2",
        900,
      );
      expect(decisions2.map((d) => d.ticker)).toEqual(["aapl", "msft"]);

      // npc-3 should have all
      const decisions3 = buildMockDecisions(
        targetTickers,
        existingKeys,
        "npc-3",
        900,
      );
      expect(decisions3.map((d) => d.ticker)).toEqual(["aapl", "goog", "msft"]);
    });

    it("should handle empty target tickers", () => {
      const existingKeys = new Set<string>();
      const decisions = buildMockDecisions([], existingKeys, "npc-1", 1000);
      expect(decisions.length).toBe(0);
    });

    it("should handle zero budget", () => {
      const existingKeys = new Set<string>();
      const targetTickers = ["aapl", "goog"];
      const decisions = buildMockDecisions(
        targetTickers,
        existingKeys,
        "npc-1",
        0,
      );
      expect(decisions.length).toBe(0);
    });
  });
});
