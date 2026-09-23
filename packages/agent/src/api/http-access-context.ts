/**
 * Maps a boundary-resolved HTTP principal onto the core {@link AccessContext}
 * DTO that use-case layers consume for per-viewer disclosure (#14781). This is
 * the HTTP-side counterpart of the message-driven `buildAccessContext`: where
 * a connector message resolves its role against a world, an HTTP viewer's role
 * comes from whichever registered {@link TokenRoleResolver} recognized the
 * request (WaifuChat, artifact share-viewer, …).
 *
 * A host-bound required context takes precedence and cannot fall back after
 * revocation. The legacy trunk-authorized owner boundary yields `undefined` — the
 * documented single-owner contract on `RouteHandlerContext.accessContext`
 * ("omitted means preserve existing unfiltered behavior"), so the local
 * dashboard is byte-for-byte unchanged. A resolver principal whose id is not
 * already a UUID (e.g. a wallet address) is mapped to a deterministic UUID so
 * downstream grant/scope comparisons operate on the entity vocabulary.
 */
import type http from "node:http";
import {
  type AccessContext,
  ElizaError,
  stringToUuid,
  type UUID,
  validateUuid,
} from "@elizaos/core";
import { resolveRegisteredTokenRoleAccess } from "./boundary-role-resolver.ts";

type RequiredHttpAccessContext = AccessContext & {
  authorizedRoomIds: readonly UUID[];
};

const requiredContexts = new WeakMap<
  http.IncomingMessage,
  RequiredHttpAccessContext | null
>();

/**
 * Carries host-verified authority into existing disclosure consumers. Only the
 * host's canonical authority resolver may call this; request bodies and headers
 * never supply these grants. Revalidation can change scope, but not the actor.
 */
export function bindRequiredHttpAccessContext(
  req: http.IncomingMessage,
  context: RequiredHttpAccessContext,
): void {
  const previous = requiredContexts.get(req);
  const wasBound = requiredContexts.has(req);
  requiredContexts.set(req, null);
  if (
    (wasBound && !previous) ||
    (previous && previous.requesterEntityId !== context.requesterEntityId) ||
    !validateUuid(context.requesterEntityId) ||
    !Array.isArray(context.authorizedRoomIds) ||
    context.authorizedRoomIds.some((roomId) => !validateUuid(roomId))
  ) {
    throw new ElizaError("Required HTTP data authority was rejected", {
      code: "HTTP_ACCESS_CONTEXT_INVALID",
    });
  }
  requiredContexts.set(
    req,
    Object.freeze({
      ...context,
      authorizedRoomIds: Object.freeze([...context.authorizedRoomIds]),
    }),
  );
}

/** A revoked request never falls back to a legacy owner or token resolver. */
export function revokeRequiredHttpAccessContext(
  req: http.IncomingMessage,
): void {
  requiredContexts.set(req, null);
}

/** Distinguishes required host scope from legacy, optionally scoped callers. */
export function resolveRequiredHttpAccessContext(
  req: http.IncomingMessage,
): RequiredHttpAccessContext | undefined {
  if (!requiredContexts.has(req)) return undefined;
  const context = requiredContexts.get(req);
  if (!context) {
    throw new ElizaError("Required HTTP data authority is revoked", {
      code: "HTTP_ACCESS_CONTEXT_REVOKED",
    });
  }
  return context;
}

/**
 * Resolve the per-viewer access context for an HTTP request, or `undefined`
 * for the single-owner boundary (trunk-authorized callers and requests no
 * resolver recognizes — the latter never reach a private route handler anyway,
 * the 401 gate already refused them).
 */
export function resolveHttpAccessContext(
  req: http.IncomingMessage,
): AccessContext | undefined {
  const required = resolveRequiredHttpAccessContext(req);
  if (required) return required;
  const access = resolveRegisteredTokenRoleAccess(req);
  if (!access) return undefined;
  const requesterEntityId =
    validateUuid(access.principal) ??
    stringToUuid(`boundary-principal:${access.providerId}:${access.principal}`);
  return {
    requesterEntityId,
    role: access.worldRole,
    isOwner: access.worldRole === "OWNER",
    source: access.providerId,
  };
}
