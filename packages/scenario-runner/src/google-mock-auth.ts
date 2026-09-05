/** Detect unexpected Google mock 401/403 so scenarios cannot pass on empty data. */
import { isLoopbackUrl } from "./utils.ts";

const GOOGLE_MOCK_AUTH_TIMEOUT_MS = 15_000;

export interface GoogleMockAuthLedgerSnapshot {
  method?: string;
  path?: string;
  statusCode?: number;
  googleAuth?: {
    action?: string;
    authStatus?: string;
    admittedAccountId?: string;
    admittedAccountEmail?: string;
    admittedGrantId?: string;
    requiredScopes?: readonly string[];
    grantedScopeCount?: number;
    resetGeneration?: number;
    statusCode?: number;
  };
}

export function unexpectedGoogleMockAuthFailureDetail(
  entries: readonly GoogleMockAuthLedgerSnapshot[],
): string | null {
  const rejected = entries.filter(
    (entry) => entry.googleAuth?.authStatus === "rejected",
  );
  if (rejected.length === 0) return null;
  const first = rejected[0];
  const status =
    first?.googleAuth?.statusCode ?? first?.statusCode ?? "401/403";
  const method = first?.method ?? "GET";
  const path = first?.path ?? "unknown";
  const account =
    first?.googleAuth?.admittedAccountEmail ??
    first?.googleAuth?.admittedAccountId ??
    first?.googleAuth?.admittedGrantId;
  const accountSuffix = account ? ` account=${account}` : "";
  return (
    `Unexpected Google mock authorization failure: ${method} ${path} ` +
    `returned ${status} (authStatus=rejected${accountSuffix}). ` +
    "Seeded grants must remain valid; empty calendar/inbox sections are not a pass."
  );
}

export async function unexpectedGoogleMockAuthorizationFailure(): Promise<
  string | null
> {
  const base = process.env.ELIZA_MOCK_GOOGLE_BASE?.trim();
  if (!base || !isLoopbackUrl(base)) return null;
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/__mock/requests`, {
      signal: AbortSignal.timeout(GOOGLE_MOCK_AUTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      requests?: GoogleMockAuthLedgerSnapshot[];
    };
    const entries = Array.isArray(body.requests) ? body.requests : [];
    return unexpectedGoogleMockAuthFailureDetail(entries);
  } catch {
    return null;
  }
}
