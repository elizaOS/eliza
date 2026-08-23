/**
 * Unit coverage for Self-Awareness shared contracts in awareness.ts.
 *
 * Tests schema version, summary limit constants, cache TTL constant,
 * and AwarenessContributor interface structural compatibility.
 */

import { describe, expect, it } from "vitest";
import type {
  AwarenessContributor,
  AwarenessInvalidationEvent,
} from "./awareness.js";
import {
  DEFAULT_CACHE_TTL_MS,
  SELF_STATUS_SCHEMA_VERSION,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_TOTAL_CHAR_LIMIT,
} from "./awareness.js";

describe("awareness contracts", () => {
  it("exports valid schema version and limits", () => {
    expect(SELF_STATUS_SCHEMA_VERSION).toBe(1);
    expect(SUMMARY_CHAR_LIMIT).toBe(80);
    expect(SUMMARY_TOTAL_CHAR_LIMIT).toBe(1200);
    expect(SUMMARY_CHAR_LIMIT).toBeLessThan(SUMMARY_TOTAL_CHAR_LIMIT);
  });

  it("exports positive default cache TTL", () => {
    expect(DEFAULT_CACHE_TTL_MS).toBe(60_000);
    expect(DEFAULT_CACHE_TTL_MS).toBeGreaterThan(0);
  });

  it("satisfies AwarenessContributor interface contract", async () => {
    const invalidationEvents: AwarenessInvalidationEvent[] = [
      "permission-changed",
      "plugin-changed",
      "wallet-updated",
      "provider-changed",
      "config-changed",
      "runtime-restarted",
      "opinion-updated",
    ];

    const contributor: AwarenessContributor = {
      id: "wallet",
      position: 30,
      summary: async () => "Wallet balance: 100 SOL",
      detail: async (_runtime, level) =>
        level === "brief" ? "Wallet brief" : "Wallet full",
      cacheTtl: 30_000,
      invalidateOn: invalidationEvents,
      trusted: true,
    };

    expect(contributor.id).toBe("wallet");
    expect(contributor.position).toBe(30);
    expect(await contributor.summary({} as unknown as IAgentRuntime)).toBe(
      "Wallet balance: 100 SOL",
    );
    expect(
      await contributor.detail?.({} as unknown as IAgentRuntime, "brief"),
    ).toBe("Wallet brief");
    expect(contributor.cacheTtl).toBe(30_000);
    expect(contributor.invalidateOn?.length).toBe(7);
    expect(contributor.trusted).toBe(true);
  });
});
