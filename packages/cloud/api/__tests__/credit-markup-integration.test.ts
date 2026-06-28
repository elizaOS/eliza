/**
 * Verifies the credit-markup wiring used by the monetized routes:
 *   - mcp/proxy/[mcpId]/route.ts
 *   - agents/[id]/mcp/route.ts
 *   - agents/[id]/a2a/route.ts
 *
 * The pure arithmetic lives in `@elizaos/cloud-shared/billing`; that package
 * already has its own unit tests for `calculateCreditMarkup`. Here we lock
 * in the parameter-wiring assumptions the routes make so a refactor of the
 * shared module surfaces immediately instead of via an e2e failure:
 *
 *   - `DEFAULT_PLATFORM_FEE_RATE` is in the (0, 1) fraction range, not 0..100.
 *   - When called with the same `{ baseCredits, markupPercent, platformFeeRate }`
 *     shape the routes use, the breakdown reconciles as:
 *         total = base + markup + platformFee
 *   - The breakdown surfaces every field the routes use to write metadata
 *     (`baseCredits`, `markupCredits`, `platformFeeCredits`, `totalCredits`).
 */

import { describe, expect, test } from "bun:test";

import {
  calculateCreditMarkup,
  DEFAULT_PLATFORM_FEE_RATE,
} from "@elizaos/cloud-shared/billing";

describe("credit-markup wiring (used by monetized routes)", () => {
  test("DEFAULT_PLATFORM_FEE_RATE is a fraction in (0, 1)", () => {
    expect(DEFAULT_PLATFORM_FEE_RATE).toBeGreaterThan(0);
    expect(DEFAULT_PLATFORM_FEE_RATE).toBeLessThan(1);
  });

  test("reconciles total = base + markup + platformFee for the MCP-proxy shape", () => {
    // Mirrors the call in packages/cloud/api/mcp/proxy/[mcpId]/route.ts.
    const breakdown = calculateCreditMarkup({
      baseCredits: 1,
      markupPercent: 25,
      platformFeeRate: DEFAULT_PLATFORM_FEE_RATE,
    });

    expect(breakdown.baseCredits).toBe(1);
    expect(breakdown.markupCredits).toBeCloseTo(0.25, 10);
    expect(breakdown.platformFeeCredits).toBeCloseTo(
      DEFAULT_PLATFORM_FEE_RATE,
      10,
    );
    expect(breakdown.totalCredits).toBeCloseTo(
      breakdown.baseCredits +
        breakdown.markupCredits +
        breakdown.platformFeeCredits,
      10,
    );
  });

  test("agents/.../mcp route shape (no platform fee, just creator markup)", () => {
    // Mirrors packages/cloud/api/agents/[id]/mcp/route.ts: monetized agents
    // pass creator markup only; no platform fee.
    const breakdown = calculateCreditMarkup({
      baseCredits: 100,
      markupPercent: 50,
    });

    expect(breakdown.platformFeeCredits).toBe(0);
    expect(breakdown.markupCredits).toBe(50);
    expect(breakdown.totalCredits).toBe(150);
  });

  test("agents/.../a2a route shape (creator markup, no platform fee)", () => {
    // Mirrors packages/cloud/api/agents/[id]/a2a/route.ts.
    const breakdown = calculateCreditMarkup({
      baseCredits: 0.005, // input-token cost per 1k from the agent card
      markupPercent: 10,
    });

    expect(breakdown.baseCredits).toBe(0.005);
    expect(breakdown.markupCredits).toBeCloseTo(0.0005, 10);
    expect(breakdown.platformFeeCredits).toBe(0);
    expect(breakdown.totalCredits).toBeCloseTo(0.0055, 10);
  });

  test("zero markup → total equals base for free routes", () => {
    const breakdown = calculateCreditMarkup({
      baseCredits: 7.5,
      markupPercent: 0,
    });
    expect(breakdown.totalCredits).toBe(7.5);
    expect(breakdown.markupCredits).toBe(0);
    expect(breakdown.platformFeeCredits).toBe(0);
  });
});
