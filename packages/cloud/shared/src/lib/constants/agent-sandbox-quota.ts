/**
 * Per-org ceiling on live (non-terminal) dedicated agent sandboxes, by credit
 * tier. Every dedicated/custom sandbox provisions a real container + per-tenant
 * DB + ingress on the shared fleet, and the create-time credit gate is
 * threshold-only (no per-agent debit), so without a per-org cap a caller on a
 * trivial (~$0.11) balance could loop a create endpoint and exhaust the fleet —
 * a DoS for every other tenant (#11023).
 *
 * Mirrors the balance tiers already enforced for cloud characters in
 * `/api/v1/app/agents` (`AGENT_LIMITS`). A trivial balance lands in the smallest
 * tier, bounding the DoS; funded orgs scale up. Shared by every user-facing
 * container-create route (`POST /api/v1/eliza/agents`,
 * `POST /api/v1/coding-containers`) so the ceiling can't drift between them;
 * trusted internal multi-agent callers pass no cap and stay uncapped.
 */

import { ElizaError } from "@elizaos/core/edge";

export type AgentSandboxLimitSource = "organizations.credit_balance" | "default_free_tier";

export interface AgentSandboxLimitResolution {
  limit: number;
  source: AgentSandboxLimitSource;
}

/** Resolve the sandbox ceiling together with the authoritative source used. */
export function resolveMaxNonTerminalAgentsForOrg(
  creditBalance: unknown,
): AgentSandboxLimitResolution {
  if (creditBalance === undefined) {
    return { limit: 5, source: "default_free_tier" };
  }
  if (typeof creditBalance !== "number" || !Number.isFinite(creditBalance)) {
    throw new ElizaError("Agent sandbox quota credit balance must be a finite number", {
      code: "INVALID_AGENT_SANDBOX_QUOTA_SOURCE",
      context: { source: "organizations.credit_balance" },
      severity: "fatal",
    });
  }

  if (creditBalance >= 100.0) {
    return { limit: 500, source: "organizations.credit_balance" };
  }
  if (creditBalance >= 10.0) {
    return { limit: 100, source: "organizations.credit_balance" };
  }
  if (creditBalance >= 1.0) {
    return { limit: 20, source: "organizations.credit_balance" };
  }
  return { limit: 5, source: "organizations.credit_balance" };
}

export function getMaxNonTerminalAgentsForOrg(creditBalance: unknown): number {
  return resolveMaxNonTerminalAgentsForOrg(creditBalance).limit;
}
