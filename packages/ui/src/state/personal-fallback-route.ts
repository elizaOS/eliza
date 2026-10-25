/**
 * Chat-side owner of the personal Eliza Dedicated-to-Shared fallback route
 * (#25146). While the app talks to the rowless personal Shared base it asks
 * `/api/v1/eliza/personal` which runtime serves the account and:
 * - Dedicated owns routing: repoints the live chat in place to that Dedicated
 *   agent (same logical identity, composer draft untouched);
 * - Dedicated access withdrawn: exposes the typed account state for the chat
 *   banner (state, reason, retention deadline, pay action);
 * - between runtimes (503): exposes a retryable state.
 * The server is the only authority; nothing here infers billing state.
 */

import { useSyncExternalStore } from "react";
import { client } from "../api/client";
import { getCloudAuthToken } from "../api/client-cloud";
import {
  describePersonalRouteRefusal,
  type PersonalFallbackAccountState,
  type PersonalRouteRefusal,
} from "../api/personal-fallback";
import { silentlyRepointToDedicated } from "../cloud/handoff/silent-repoint";
import {
  directCloudSharedAgentIdFromBase,
  isPersonalSharedElizaId,
} from "../utils/cloud-agent-base";

export type PersonalFallbackView =
  | { status: "idle" }
  | {
      status: "shared_fallback";
      accountState: PersonalFallbackAccountState;
      cloudApiBase: string;
    }
  | {
      status: "retrying";
      code: Extract<PersonalRouteRefusal, { kind: "retry" }>["code"];
      retryAfterSeconds: number | null;
    };

export type PersonalRouteOutcome =
  | { status: "not_personal_shared" }
  | { status: "unauthenticated" }
  | { status: "switched"; activeAgentId: string }
  | { status: "shared"; accountState: PersonalFallbackAccountState | null }
  | {
      status: "retrying";
      refusal: Extract<PersonalRouteRefusal, { kind: "retry" }>;
    }
  | { status: "failed"; error: unknown };

const IDLE: PersonalFallbackView = { status: "idle" };
let view: PersonalFallbackView = IDLE;
const listeners = new Set<() => void>();
let inFlight: Promise<PersonalRouteOutcome> | null = null;

function setView(next: PersonalFallbackView): void {
  if (next === view) return;
  view = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPersonalFallbackView(): PersonalFallbackView {
  return view;
}

export function usePersonalFallbackView(): PersonalFallbackView {
  return useSyncExternalStore(subscribe, getPersonalFallbackView, () => IDLE);
}

/** Record a 503 route refusal seen by a chat request. */
export function markPersonalRouteRetrying(
  refusal: Extract<PersonalRouteRefusal, { kind: "retry" }>,
): void {
  setView({
    status: "retrying",
    code: refusal.code,
    retryAfterSeconds: refusal.retryAfterSeconds,
  });
}

/** The personal Shared identity the live client is bound to, if any. */
function personalSharedTarget(): {
  personalElizaId: string;
  cloudApiBase: string;
} | null {
  const base = client.getBaseUrl();
  const agentId = directCloudSharedAgentIdFromBase(base);
  if (!agentId || !isPersonalSharedElizaId(agentId)) return null;
  try {
    return { personalElizaId: agentId, cloudApiBase: new URL(base).origin };
  } catch {
    // error-policy:J3 an unparseable base cannot address the control plane.
    return null;
  }
}

async function resolveRoute(): Promise<PersonalRouteOutcome> {
  const target = personalSharedTarget();
  if (!target) {
    setView(IDLE);
    return { status: "not_personal_shared" };
  }
  const authToken = getCloudAuthToken(client);
  if (!authToken) return { status: "unauthenticated" };
  let personal: Awaited<ReturnType<typeof client.getPersonalSharedEliza>>;
  try {
    personal = await client.getPersonalSharedEliza({
      cloudApiBase: target.cloudApiBase,
      authToken,
    });
  } catch (error) {
    const refusal = describePersonalRouteRefusal(error);
    if (refusal?.kind === "retry") {
      markPersonalRouteRetrying(refusal);
      return { status: "retrying", refusal };
    }
    return { status: "failed", error };
  }
  // The user may have switched runtimes while the lookup was in flight; only
  // the identity still bound to the chat may be repointed.
  if (personalSharedTarget()?.personalElizaId !== target.personalElizaId) {
    return { status: "not_personal_shared" };
  }
  if (personal.personalElizaId !== target.personalElizaId) {
    return {
      status: "failed",
      error: new Error(
        "Eliza Cloud resolved a different personal Eliza than the one in this chat.",
      ),
    };
  }
  if (personal.runtime === "dedicated") {
    silentlyRepointToDedicated({
      containerBase: personal.apiBase,
      dedicatedAgentId: personal.activeAgentId,
      authToken,
      personalElizaId: personal.personalElizaId,
    });
    setView(IDLE);
    return { status: "switched", activeAgentId: personal.activeAgentId };
  }
  const accountState = personal.accountState ?? null;
  setView(
    accountState
      ? {
          status: "shared_fallback",
          accountState,
          cloudApiBase: target.cloudApiBase,
        }
      : IDLE,
  );
  return { status: "shared", accountState };
}

/**
 * Re-resolve the personal route for the chat's current base. Single-flight:
 * concurrent callers (the banner's refresh and a 409 from a send) share one
 * lookup and at most one repoint.
 */
export function refreshPersonalRoute(): Promise<PersonalRouteOutcome> {
  if (!inFlight) {
    inFlight = resolveRoute().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Test-only: forget cached view state between cases. */
export function __resetPersonalFallbackRouteForTests(): void {
  inFlight = null;
  view = IDLE;
  listeners.clear();
}
