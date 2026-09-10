/**
 * Rowless personal-Eliza resolution for the app-mode entry gate. After the
 * rowless personal rollout a clean account has ZERO `/api/v1/eliza/agents`
 * rows, so entry can no longer treat sandbox rows as the only proof that chat
 * can boot. This hook resolves the signed-in account's authoritative personal
 * Cloud binding (`cloud:personal:<uuid>`) by running the same `runJoinFlow`
 * controller `/join` uses. It validates the identity against the current
 * Steward session token (never trusting localStorage alone) and persists the
 * authoritative binding. Entry never activates or adopts a Dedicated target;
 * an unavailable identity fails closed into the retryable `/join` error UI.
 *
 * Callers gate on `enabled` so the request only fires for the rowless case;
 * resolution failure surfaces as a query error and the entry gate falls back
 * to `/join`, which owns the retryable error UI.
 */

import {
  getStewardTabSessionAuthorityCoordinator,
  STEWARD_SESSION_CHANGE_EVENT,
  StewardSessionAuthorityError,
} from "@elizaos/shared/steward-session-client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
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
export function usePersonalEntry(enabled: boolean): Pick<
  UseQueryResult<JoinFlowResult>,
  "data" | "isError"
> & {
  needsRetry: boolean;
} {
  // Entry is a publication attempt, not a reusable account-data cache. The
  // one-shot /join handoff owns reuse across the renderer swap instead.
  const entryId = useId();
  const active = useRef<{
    controller: AbortController;
    revalidate: () => void;
  } | null>(null);
  const [invalidated, setInvalidated] = useState<Error | null>(null);
  const query = useQuery<JoinFlowResult>({
    queryKey: ["app-mode", "personal-entry", entryId],
    queryFn: async ({ signal: querySignal }) => {
      const authToken = resolveJoinAuthToken();
      if (!authToken) {
        throw new Error(
          "PersonalEntry: no Steward session token for an authenticated entry.",
        );
      }
      const coordinator = getStewardTabSessionAuthorityCoordinator();
      const snapshot = coordinator.readSnapshot();
      const cloudApiBase = resolveJoinCloudApiBase();
      const controller = new AbortController();
      const signal = AbortSignal.any([querySignal, controller.signal]);
      const revalidate = () => {
        signal.throwIfAborted();
        coordinator.assertSnapshot(snapshot);
        if (
          resolveJoinAuthToken() !== authToken ||
          resolveJoinCloudApiBase() !== cloudApiBase
        ) {
          throw new StewardSessionAuthorityError(
            "Personal entry context changed. Try again.",
            "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
          );
        }
      };
      active.current = { controller, revalidate };
      revalidate();
      const handedOff = takePersonalEntryHandoff(authToken);
      if (handedOff) return handedOff;
      const result = await runJoinFlow({
        client,
        effects: { savePersistedActiveServer, savePersistedFirstRunComplete },
        cloudApiBase,
        authToken,
        signal,
        revalidate,
      });
      revalidate();
      return result;
    },
    enabled: enabled && !invalidated,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    const invalidate = () => {
      const attempt = active.current;
      if (!attempt || attempt.controller.signal.aborted) return;
      const error = new StewardSessionAuthorityError(
        "Personal entry context changed. Try again.",
        "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
      );
      attempt.controller.abort(error);
      setInvalidated(error);
    };
    const checkSession = () => {
      try {
        active.current?.revalidate();
      } catch {
        // error-policy:J4 withdraw stale entry and let /join own explicit recovery.
        invalidate();
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) invalidate();
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, checkSession);
    window.addEventListener("token-sync", checkSession);
    window.addEventListener("storage", checkSession);
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, checkSession);
      window.removeEventListener("token-sync", checkSession);
      window.removeEventListener("storage", checkSession);
      window.removeEventListener("pagehide", invalidate);
      window.removeEventListener("pageshow", onPageShow);
      active.current?.controller.abort(
        new DOMException("Personal entry unmounted", "AbortError"),
      );
    };
  }, []);

  const needsRetry =
    invalidated !== null || query.error instanceof StewardSessionAuthorityError;
  return {
    data: needsRetry ? undefined : query.data,
    isError: needsRetry || query.isError,
    needsRetry,
  };
}
