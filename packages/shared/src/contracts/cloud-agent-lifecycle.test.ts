/**
 * Cloud lifecycle contract tests exercise the public runtime guards and the
 * deliberate container-backed subset consumed by database and API code.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_EXECUTION_TIERS,
  AGENT_SANDBOX_STATUSES,
  isAgentExecutionTier,
  isAgentSandboxStatus,
} from "./cloud-agent-lifecycle.js";

describe("Cloud agent lifecycle contracts", () => {
  it("accepts every published value and rejects unrecognized wire values", () => {
    for (const status of AGENT_SANDBOX_STATUSES) {
      expect(isAgentSandboxStatus(status)).toBe(true);
    }
    for (const tier of AGENT_EXECUTION_TIERS) {
      expect(isAgentExecutionTier(tier)).toBe(true);
    }
    expect(isAgentSandboxStatus("deleted")).toBe(false);
    expect(isAgentExecutionTier("future-container")).toBe(false);
  });
});
