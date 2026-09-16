/**
 * Verifies that the agent awareness contracts re-export the canonical contracts
 * from @elizaos/shared, maintaining backwards compatibility without duplication.
 */

import {
  DEFAULT_CACHE_TTL_MS,
  SELF_STATUS_SCHEMA_VERSION,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_TOTAL_CHAR_LIMIT,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import * as agentAwareness from "../contracts/awareness.ts";

describe("agent awareness contract re-exports", () => {
  it("exports canonical constants matching @elizaos/shared", () => {
    expect(agentAwareness.SELF_STATUS_SCHEMA_VERSION).toBe(
      SELF_STATUS_SCHEMA_VERSION,
    );
    expect(agentAwareness.DEFAULT_CACHE_TTL_MS).toBe(DEFAULT_CACHE_TTL_MS);
    expect(agentAwareness.SUMMARY_CHAR_LIMIT).toBe(SUMMARY_CHAR_LIMIT);
    expect(agentAwareness.SUMMARY_TOTAL_CHAR_LIMIT).toBe(
      SUMMARY_TOTAL_CHAR_LIMIT,
    );
  });

  it("exports the expected runtime schema version", () => {
    expect(agentAwareness.SELF_STATUS_SCHEMA_VERSION).toBe(1);
  });
});
