/**
 * Normalize the `auth` field on a coding-agent preflight row so the
 * server-side response shape matches the client type declared in
 * `packages/app-core/src/api/client-types-cloud.ts`:
 *
 *     auth?: {
 *       status: "authenticated" | "unauthenticated" | "unknown";
 *       method?: string;
 *       detail?: string;
 *       loginHint?: string;
 *     };
 *
 * The upstream `coding-agent-adapters` package types the auth field
 * as `unknown`. Before this normalizer, the route handlers just cast
 * the raw value to `Record<string, unknown>` and forwarded it, which
 * meant a shape drift in the adapter would silently break the UI's
 * `needsAuth` check (`preflightByAgent[agent]?.auth?.status === "unauthenticated"`).
 * TypeScript would still compile, but the Authenticate button would
 * never render. Normalizing at the boundary pins the contract.
 */

export type PreflightAuthStatus =
  | "authenticated"
  | "unauthenticated"
  | "unknown";

export interface NormalizedPreflightAuth {
  status: PreflightAuthStatus;
  method?: string;
  detail?: string;
  loginHint?: string;
}

export function normalizePreflightAuth(
  raw: unknown,
): NormalizedPreflightAuth | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const rawStatus = typeof r.status === "string" ? r.status : "";
  let status: PreflightAuthStatus;
  if (rawStatus === "authenticated" || rawStatus === "unauthenticated") {
    status = rawStatus;
  } else {
    // Unknown or missing status → "unknown". This keeps the contract
    // tight while still surfacing *something* to the UI (the agent
    // tab will render without the Authenticate button, matching the
    // pre-feature behavior for adapters that don't report auth).
    status = "unknown";
  }
  const out: NormalizedPreflightAuth = { status };
  if (typeof r.method === "string") out.method = r.method;
  if (typeof r.detail === "string") out.detail = r.detail;
  if (typeof r.loginHint === "string") out.loginHint = r.loginHint;
  return out;
}
