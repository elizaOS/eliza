/**
 * Rowless personal-Eliza resolution for the app-mode entry gate. After the
 * rowless personal rollout a clean account has ZERO `/api/v1/eliza/agents`
 * rows, so entry can no longer treat sandbox rows as the only proof that chat
 * can boot. This hook resolves the signed-in account's authoritative personal
 * Cloud binding (`cloud:personal:<uuid>`) by running the same `runJoinFlow`
 * controller `/join` uses. It validates the identity against the current
 * Steward session token (never trusting localStorage alone) and persists the
 * authoritative binding. If an existing Dedicated target requires explicit
 * adoption consent, this headless entry attempt fails closed and routes to
 * `/join`, which owns the visible quote review and confirmation gesture.
 *
 * Callers gate on `enabled` so the request only fires for the rowless case;
 * resolution failure surfaces as a query error and the entry gate falls back
 * to `/join`, which owns the retryable error UI.
 */

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { client } from "../../api";
import {
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../../state/persistence";
import {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "../join/lib/resolve-cloud-connection";
import { type JoinFlowResult, runJoinFlow } from "../join/lib/run-join-flow";

interface PersonalEntryHandoff {
  authToken: string;
  result: JoinFlowResult;
}

let pendingPersonalEntryHandoff: PersonalEntryHandoff | null = null;

/**
 * Carry the already-authoritative `/join` result across the public-to-full
 * renderer swap. The Steward token binds the one-shot receipt to the session
 * that resolved it, so a later account can never consume stale identity state.
 */
export function publishPersonalEntryHandoff(
  authToken: string,
  result: JoinFlowResult,
): void {
  pendingPersonalEntryHandoff = { authToken, result };
}

function takePersonalEntryHandoff(authToken: string): JoinFlowResult | null {
  const pending = pendingPersonalEntryHandoff;
  pendingPersonalEntryHandoff = null;
  return pending?.authToken === authToken ? pending.result : null;
}

/** The persisted-active-server id a resolved personal Eliza binds under. */
export function personalEntryBindingId(result: JoinFlowResult): string {
  return `cloud:${result.agentId}`;
}

/**
 * Resolve + persist the account's personal Eliza binding. Enabled only for the
 * authenticated rowless entry path; `retry: false` so an unavailable identity
 * endpoint fails over to `/join` promptly instead of holding the entry notice.
 */
export function usePersonalEntry(
  enabled: boolean,
): UseQueryResult<JoinFlowResult> {
  return useQuery<JoinFlowResult>({
    queryKey: ["app-mode", "personal-entry"],
    queryFn: async () => {
      const authToken = resolveJoinAuthToken();
      if (!authToken) {
        throw new Error(
          "PersonalEntry: no Steward session token for an authenticated entry.",
        );
      }
      const handedOff = takePersonalEntryHandoff(authToken);
      if (handedOff) return handedOff;
      return runJoinFlow({
        client,
        effects: { savePersistedActiveServer, savePersistedFirstRunComplete },
        cloudApiBase: resolveJoinCloudApiBase(),
        authToken,
      });
    },
    enabled,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
