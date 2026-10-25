/**
 * Boundary-role resolution extension point (#12087 item 12).
 *
 * The agent HTTP boundary has exactly one canonical role vocabulary
 * (`BoundaryRole` = OWNER | GUEST — see `resolveBoundaryRole` in
 * server-helpers-auth). Product surfaces that ride on top of the agent (e.g.
 * WaifuChat) historically baked their *own* token vocabulary, JWT parsing,
 * issuer/audience checks and role→world-role mapping directly into the trunk
 * auth helper. That put a product-specific role scheme in `@elizaos/agent`'s
 * core auth path, where it drifted independently of the canonical roles.
 *
 * This module is the seam that fixes that: a product registers a
 * {@link TokenRoleResolver} that owns *its* token parsing and *its* mapping to
 * canonical world roles. The trunk auth helper iterates the registered
 * resolvers and knows nothing about any product's tokens, issuers, or role
 * literals. The truth for "what does a waifu token mean" now lives with the
 * waifu resolver, not in the trunk.
 *
 * Contract:
 *  - A resolver returns a {@link BoundaryRoleAccess} when it recognises and
 *    validates the request, or `null` to defer to the next resolver.
 *  - Resolvers are consulted in registration order; the first non-null wins.
 *  - Registration is process-global and idempotent per `id` (re-registering the
 *    same id replaces the prior resolver) so a plugin can register once at load
 *    without double-stacking under hot reload / repeated imports.
 *  - The trunk never inspects `providerId` for behaviour; it is opaque metadata
 *    for diagnostics only.
 */
import type http from "node:http";

/** Canonical world role a boundary token maps onto. */
export type BoundaryWorldRole = "OWNER" | "USER" | "GUEST";

/**
 * The canonical result a {@link TokenRoleResolver} produces for a request it
 * recognises. `worldRole` is the only field the trunk gate consumes; the rest
 * is opaque identity/claims the owning product's routes read back through their
 * own resolver, never through the trunk.
 */
export interface BoundaryRoleAccess {
  /** Which resolver produced this (opaque, diagnostics only). */
  providerId: string;
  /** Canonical world role this token maps onto. */
  worldRole: BoundaryWorldRole;
  /** Stable principal identity string (e.g. a wallet address). */
  principal: string;
  /** Whether this principal is a full-authority admin for its product. */
  isAdmin: boolean;
  /**
   * Whether this route is in scope for a non-admin principal of this product.
   * Consulted only when `isAdmin` is false; admins are always authorized.
   */
  isRouteInScope: (method: string, pathname: string) => boolean;
  /** Product-owned claims, opaque to the trunk. */
  claims: Readonly<Record<string, unknown>>;
}

/**
 * A product-owned boundary-role resolver. Owns its token vocabulary end to end.
 */
export interface TokenRoleResolver {
  /** Stable, unique id (e.g. "waifu-chat"). Re-registering replaces. */
  readonly id: string;
  /**
   * Recognise + validate the request and return canonical boundary access, or
   * `null` to defer. Must be pure w.r.t. the request (no mutation) and must not
   * throw for malformed input — return `null` instead.
   */
  resolve(req: http.IncomingMessage): BoundaryRoleAccess | null;
}

const resolvers = new Map<string, TokenRoleResolver>();

/**
 * Register (or replace) a boundary-role resolver. Idempotent per `id`.
 * Returns an unregister function.
 */
export function registerTokenRoleResolver(
  resolver: TokenRoleResolver,
): () => void {
  resolvers.set(resolver.id, resolver);
  return () => {
    // Only remove if the same instance is still registered (a later
    // re-registration of the same id owns the slot).
    if (resolvers.get(resolver.id) === resolver) {
      resolvers.delete(resolver.id);
    }
  };
}

/** Test/reset hook: drop all registered resolvers. */
export function clearTokenRoleResolvers(): void {
  resolvers.clear();
}

/** Whether a resolver is registered for the given id. */
export function hasTokenRoleResolver(id: string): boolean {
  return resolvers.has(id);
}

/**
 * Consult every registered resolver in registration order; return the first
 * non-null {@link BoundaryRoleAccess}, or `null` if none recognise the request.
 * A resolver that throws is treated as a non-match (fail-closed for that
 * resolver, not for the whole gate).
 */
export function resolveRegisteredTokenRoleAccess(
  req: http.IncomingMessage,
): BoundaryRoleAccess | null {
  for (const resolver of resolvers.values()) {
    let access: BoundaryRoleAccess | null = null;
    try {
      access = resolver.resolve(req);
    } catch {
      access = null;
    }
    if (access) return access;
  }
  return null;
}

/**
 * The trunk authorization predicate for registered boundary resolvers. A
 * recognised admin is always authorized; a recognised non-admin is authorized
 * only for routes its resolver declares in scope. Unrecognised → false (defer
 * to the trunk's own token/loopback auth).
 */
export function isRegisteredTokenRoleAuthorized(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
): boolean {
  const access = resolveRegisteredTokenRoleAccess(req);
  if (!access) return false;
  if (access.isAdmin) return true;
  return access.isRouteInScope(method.toUpperCase(), pathname);
}
