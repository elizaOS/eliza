/**
 * Maps a boundary-resolved HTTP principal onto the core {@link AccessContext}
 * DTO that use-case layers consume for per-viewer disclosure (#14781). This is
 * the HTTP-side counterpart of the message-driven `buildAccessContext`: where
 * a connector message resolves its role against a world, an HTTP viewer's role
 * comes from whichever registered {@link TokenRoleResolver} recognized the
 * request (WaifuChat, artifact share-viewer, …).
 *
 * The trunk-authorized owner boundary deliberately yields `undefined` — the
 * documented single-owner contract on `RouteHandlerContext.accessContext`
 * ("omitted means preserve existing unfiltered behavior"), so the local
 * dashboard is byte-for-byte unchanged. A resolver principal whose id is not
 * already a UUID (e.g. a wallet address) is mapped to a deterministic UUID so
 * downstream grant/scope comparisons operate on the entity vocabulary.
 */
import type http from "node:http";
import { type AccessContext, stringToUuid, validateUuid } from "@elizaos/core";
import { resolveRegisteredTokenRoleAccess } from "./boundary-role-resolver.ts";

/**
 * Resolve the per-viewer access context for an HTTP request, or `undefined`
 * for the single-owner boundary (trunk-authorized callers and requests no
 * resolver recognizes — the latter never reach a private route handler anyway,
 * the 401 gate already refused them).
 */
export function resolveHttpAccessContext(
  req: http.IncomingMessage,
): AccessContext | undefined {
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
