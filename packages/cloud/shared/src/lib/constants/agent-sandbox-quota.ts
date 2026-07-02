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
export function getMaxNonTerminalAgentsForOrg(creditBalance: number | undefined): number {
  const balance = Number(creditBalance ?? 0);
  if (balance >= 100.0) return 500;
  if (balance >= 10.0) return 100;
  if (balance >= 1.0) return 20;
  return 5;
}
