/**
 * Single source of truth for the set of request paths considered
 * "sensitive" — i.e. money-, key-, auth-, or tenant-administration surfaces
 * that MUST be both freshness-checked (request-expiry) AND signature-checked
 * (authorization-signature) when those guards are enabled.
 *
 * Previously this predicate was duplicated byte-for-byte in
 * `request-expiry.ts` and `authorization-signature.ts`. Keeping two copies in
 * lockstep is a drift hazard: if one copy gained or dropped a prefix, a path
 * could be freshness-checked but not signature-checked (or vice-versa),
 * silently weakening a load-bearing guard. Both middlewares now import this
 * one helper so the two guards always cover the exact same surface.
 *
 * The prefix set is the conservative UNION of what each copy historically
 * treated as sensitive (the two copies were already identical, so the union is
 * that same set), plus the money-/key-/auth-adjacent surfaces added in SEC-150
 * (`/v1/kms`, `/v2/provider-actions`, `/dashboard`, `/agent-enroll`). Adding a
 * prefix here tightens BOTH guards together; never narrow it without auditing
 * both call sites.
 */

/** Path prefixes whose mutating requests are treated as sensitive. */
export const SENSITIVE_PATH_PREFIXES: readonly string[] = [
  "/vault",
  "/agents",
  "/v1/agents",
  "/wallets/batch",
  "/v1/wallets/batch",
  "/accounts",
  "/v1/accounts",
  "/adapters",
  "/v1/adapters",
  "/policies",
  "/v1/policies",
  "/secrets",
  "/trade",
  "/v1/trade",
  "/approvals",
  "/intents",
  "/audit",
  "/auth",
  "/global-wallet",
  "/user",
  "/v1/users",
  "/webhooks",
  "/tenants",
  "/platform",
  "/condition-sets",
  "/v1/condition-sets",
  "/condition_sets",
  "/v1/condition_sets",
  "/v2/workspaces",
  "/v2/provider-accounts",
  "/v2/provider-role-bindings",
  "/v2/provider-grants",
  // Money-movement + key-material + auth-adjacent surfaces that must stay
  // covered (SEC-150): KMS key ops, provider action execution/approval,
  // dashboard session mutations, and agent enrollment.
  "/v1/kms",
  "/v2/provider-actions",
  "/dashboard",
  "/agent-enroll",
  "/v1/agent-enroll",
];

/**
 * True when `path` falls under a sensitive surface. Matched by prefix so both
 * a collection route (`/agents`) and its sub-resources (`/agents/:id/...`) are
 * covered.
 */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}
