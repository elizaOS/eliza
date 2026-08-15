/**
 * Rowless personal-Eliza resolution for the app-mode entry gate. After the
 * rowless personal rollout a clean account has ZERO `/api/v1/eliza/agents`
 * rows, so entry can no longer treat sandbox rows as the only proof that chat
 * can boot. This hook resolves the signed-in account's authoritative personal
 * Cloud binding (`cloud:personal:<uuid>`) by running the same read-only
 * `runJoinFlow` controller `/join` uses: it validates the identity against the
 * current Steward session token (never trusting localStorage alone), persists
 * the authoritative binding, and never provisions or starts paid compute.
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
