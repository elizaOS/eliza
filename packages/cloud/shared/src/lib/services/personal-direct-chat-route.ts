/**
 * Entitlement-aware target resolution for direct personal chat (#25146).
 *
 * Every direct entry point that addresses the rowless `personal:` identity
 * (the app's REST conversations, messages and streaming surfaces, the JSON-RPC
 * bridge and stream, and the personal identity lookup) resolves its
 * destination here, through the same authority the connector paths use:
 * - no cut-over Dedicated: the ordinary Shared conversation;
 * - Dedicated access withdrawn: the interval's separately scoped Shared
 *   journal with the typed account-state provider. The canonical room (and
 *   with it every Dedicated and pre-upgrade turn) is never read;
 * - Dedicated owns routing: a recovered interval is reconciled into the same
 *   Dedicated agent id before that id is handed back.
 */

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { findActivePersonalDedicatedTarget } from "./agent-tier-upgrade-target";
import {
  type PersonalDedicatedFallback,
  type PersonalDedicatedFallbackEffects,
  type PersonalSharedFallbackAccountState,
  resolvePersonalDedicatedRoute,
} from "./personal-dedicated-fallback";
import { reconcilePersonalFallbackIntoDedicated } from "./personal-dedicated-fallback-reconcile";

export interface PersonalDirectChatRefusal {
  route: "refused";
  status: 404 | 409 | 503;
  code:
    | "conversation_not_found"
    | "personal_eliza_dedicated"
    | "dedicated_fallback_pending"
    | "dedicated_reconciling";
  error: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  /** The Dedicated agent id that owns this conversation (409 only). */
  activeAgentId?: string;
}

export type PersonalDirectChatRoute =
  | { route: "shared"; roomId: string }
  | {
      route: "shared_fallback";
      /** The interval's scoped journal; never the canonical conversation. */
      roomId: string;
      accountState: PersonalSharedFallbackAccountState;
      fallback: PersonalDedicatedFallback;
    }
  | { route: "dedicated"; dedicated: AgentSandbox }
  | PersonalDirectChatRefusal;

export interface PersonalDirectChatRouteInput {
  organizationId: string;
  userId: string;
  /** The canonical `personal:` identity; also the canonical conversation id. */
  sourceAgentId: string;
  /** Requested conversation/room. Omitted for identity-only lookups. */
  conversationId?: string;
  /** Conversation coordinator; required only to reconcile a recovered interval. */
  namespace?: RuntimeDurableObjectNamespace;
  effects?: PersonalDedicatedFallbackEffects;
}

/** Refusal for a Shared chat surface when Dedicated owns this conversation. */
export function personalDedicatedOwnsConversation(
  dedicatedAgentId: string,
): PersonalDirectChatRefusal {
  return {
    route: "refused",
    status: 409,
    code: "personal_eliza_dedicated",
    error: "This personal Eliza is active on Dedicated.",
    retryable: false,
    activeAgentId: dedicatedAgentId,
  };
}

export async function resolvePersonalDirectChatRoute(
  input: PersonalDirectChatRouteInput,
): Promise<PersonalDirectChatRoute> {
  const dedicated = await findActivePersonalDedicatedTarget(
    input.organizationId,
    input.userId,
    input.sourceAgentId,
  );
  if (!dedicated) {
    return { route: "shared", roomId: input.conversationId ?? input.sourceAgentId };
  }
  const route = await resolvePersonalDedicatedRoute({
    dedicated,
    organizationId: input.organizationId,
    userId: input.userId,
    sourceAgentId: input.sourceAgentId,
    ...(input.effects ? { effects: input.effects } : {}),
  });
  if (route.route === "unavailable") {
    return {
      route: "refused",
      status: route.status,
      code: route.code,
      error: route.error,
      retryable: route.retryable,
      retryAfterSeconds: route.retryAfterSeconds,
    };
  }
  if (route.route === "shared_fallback") {
    const { journalRoomId } = route.delivery;
    // The app keeps addressing the canonical conversation id; it is served
    // from the scoped journal. Any other room is not this account's fallback.
    if (
      input.conversationId !== undefined &&
      input.conversationId !== input.sourceAgentId &&
      input.conversationId !== journalRoomId
    ) {
      return {
        route: "refused",
        status: 404,
        code: "conversation_not_found",
        error: "Conversation not found",
        retryable: false,
      };
    }
    return {
      route: "shared_fallback",
      roomId: journalRoomId,
      accountState: route.delivery.accountState,
      fallback: route.delivery.fallback,
    };
  }
  if (route.reconcile) {
    // The complete Shared interval reaches the same Dedicated agent before
    // its id is handed back, so both runtimes never own the conversation.
    const reconciled = input.namespace
      ? await reconcilePersonalFallbackIntoDedicated({
          fallback: route.reconcile,
          namespace: input.namespace,
        })
      : { reconciled: false as const };
    if (!reconciled.reconciled) {
      return {
        route: "refused",
        status: 503,
        code: "dedicated_reconciling",
        error: "Dedicated Eliza is restoring your recent conversation. Try again shortly.",
        retryable: true,
        retryAfterSeconds: 5,
      };
    }
  }
  return { route: "dedicated", dedicated };
}

/**
 * The same resolution for a Shared chat surface: Dedicated ownership is a
 * typed 409 carrying the Dedicated agent id the client must switch to.
 */
export async function resolvePersonalSharedSurfaceRoute(
  input: PersonalDirectChatRouteInput,
): Promise<Exclude<PersonalDirectChatRoute, { route: "dedicated" }>> {
  const route = await resolvePersonalDirectChatRoute(input);
  return route.route === "dedicated"
    ? personalDedicatedOwnsConversation(route.dedicated.id)
    : route;
}

/** JSON body and headers for a refusal, shared by every direct surface. */
export function personalDirectChatRefusalResponse(refusal: PersonalDirectChatRefusal): {
  body: {
    success: false;
    error: string;
    code: PersonalDirectChatRefusal["code"];
    retryable: boolean;
    activeAgentId?: string;
  };
  status: PersonalDirectChatRefusal["status"];
  headers: Record<string, string>;
} {
  return {
    body: {
      success: false,
      error: refusal.error,
      code: refusal.code,
      retryable: refusal.retryable,
      ...(refusal.activeAgentId ? { activeAgentId: refusal.activeAgentId } : {}),
    },
    status: refusal.status,
    headers: refusal.retryAfterSeconds ? { "Retry-After": String(refusal.retryAfterSeconds) } : {},
  };
}

export type SharedSurfaceTarget =
  | { ok: true; roomId: string; accountState?: PersonalSharedFallbackAccountState }
  | { ok: false; refusal: PersonalDirectChatRefusal };

/**
 * The room and account state a Shared chat surface uses for one resolved
 * scope. Organization Shared agents keep the requested room unchanged; the
 * personal identity goes through {@link resolvePersonalSharedSurfaceRoute}.
 */
export async function resolveSharedSurfaceTarget(input: {
  agent: { id: string; organization_id: string; user_id: string };
  personal: boolean;
  conversationId: string;
  namespace: RuntimeDurableObjectNamespace;
}): Promise<SharedSurfaceTarget> {
  if (!input.personal) return { ok: true, roomId: input.conversationId };
  const route = await resolvePersonalSharedSurfaceRoute({
    organizationId: input.agent.organization_id,
    userId: input.agent.user_id,
    sourceAgentId: input.agent.id,
    conversationId: input.conversationId,
    namespace: input.namespace,
  });
  if (route.route === "refused") return { ok: false, refusal: route };
  if (route.route === "shared") return { ok: true, roomId: route.roomId };
  return { ok: true, roomId: route.roomId, accountState: route.accountState };
}
