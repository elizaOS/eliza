/**
 * WaifuChat boundary-role resolver (#12087 item 12).
 *
 * This module owns the ENTIRE WaifuChat role scheme that used to live in the
 * trunk auth helper (`server-helpers-auth.ts`): the product token vocabulary
 * (`admin`/`user`/`guest`), the HS256 JWT parse + issuer/audience/exp/nbf and
 * token-address/chain/agent-id checks, the route allowlist for non-admin
 * principals, and the mapping from waifu roles to canonical world roles.
 *
 * The trunk auth helper is now product-agnostic: it consults the registered
 * {@link TokenRoleResolver}s (see `boundary-role-resolver.ts`) and holds ZERO
 * waifu literals. Registering `waifuChatRoleResolver` reconnects the exact same
 * behaviour through that seam — the truth for "what a waifu token means" lives
 * here, with the product, not in `@elizaos/agent`'s core auth path.
 *
 * Behaviour is byte-identical to the pre-refactor trunk implementation: the JWT
 * validation, the wallet/claims shape, the `admin→OWNER user→USER guest→GUEST`
 * map, and the `isWaifuChatScopedRoute` allowlist are moved verbatim.
 */
import crypto from "node:crypto";
import type http from "node:http";
import {
  type BoundaryRoleAccess,
  type BoundaryWorldRole,
  registerTokenRoleResolver,
  type TokenRoleResolver,
} from "./boundary-role-resolver.ts";
import { extractAuthToken } from "./server-helpers-auth.ts";

/** The waifu resolver's stable registry id. */
export const WAIFU_CHAT_RESOLVER_ID = "waifu-chat";

/** Product-specific role vocabulary carried in WaifuChat JWTs. */
export type WaifuChatRole = "admin" | "user" | "guest";

/**
 * Canonical world roles a waifu role maps onto. Kept as a named alias so the
 * mapping table below is self-documenting; structurally identical to
 * {@link BoundaryWorldRole}.
 */
export type WaifuChatWorldRole = BoundaryWorldRole;

/**
 * The frozen waifu-role → canonical-world-role mapping. This is the single
 * source of truth for the WaifuChat role scheme (previously
 * `waifuChatRoleToWorldRole` in the trunk auth helper). Kept as a `const`
 * record so the parity test can assert the table is unchanged.
 */
export const WAIFU_CHAT_ROLE_TO_WORLD_ROLE: Readonly<
  Record<WaifuChatRole, WaifuChatWorldRole>
> = Object.freeze({
  admin: "OWNER",
  user: "USER",
  guest: "GUEST",
});

export function waifuChatRoleToWorldRole(
  role: WaifuChatRole,
): WaifuChatWorldRole {
  return WAIFU_CHAT_ROLE_TO_WORLD_ROLE[role];
}

export interface WaifuChatAccess {
  role: WaifuChatRole;
  walletAddress: string;
  tokenAddress?: string;
  chainId?: number;
  cloudAgentId?: string;
  balanceTokens?: number | null;
}

function base64UrlDecode(input: string): Buffer | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized + padding, "base64");
  } catch {
    return null;
  }
}

function readJsonSegment(segment: string): Record<string, unknown> | null {
  const decoded = base64UrlDecode(segment);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded.toString("utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function timingSafeJwtSignatureMatches(
  signingInput: string,
  signatureSegment: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(signatureSegment, "utf8");
  return (
    expectedBytes.length === actualBytes.length &&
    crypto.timingSafeEqual(expectedBytes, actualBytes)
  );
}

/**
 * Parse + validate a WaifuChat access JWT and return its canonical access, or
 * `null` if the token is absent, malformed, unsigned/invalid, expired, or fails
 * any configured issuer/audience/token-address/chain/agent-id gate. Moved
 * verbatim from `server-helpers-auth.ts`.
 */
export function resolveWaifuChatAccessToken(
  token: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): WaifuChatAccess | null {
  const secret = process.env.WAIFU_CHAT_ACCESS_JWT_SECRET?.trim();
  if (!secret || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (!headerSegment || !payloadSegment || !signatureSegment) return null;

  const header = readJsonSegment(headerSegment);
  if (header?.alg !== "HS256") return null;
  const signingInput = `${headerSegment}.${payloadSegment}`;
  if (!timingSafeJwtSignatureMatches(signingInput, signatureSegment, secret)) {
    return null;
  }

  const payload = readJsonSegment(payloadSegment);
  if (!payload) return null;
  if (payload.iss !== "waifu.fun") return null;
  const aud = payload.aud;
  if (
    aud !== "eliza-cloud-chat" &&
    !(Array.isArray(aud) && aud.includes("eliza-cloud-chat"))
  ) {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return null;
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) {
    return null;
  }

  const role = typeof payload.role === "string" ? payload.role : "";
  if (role !== "admin" && role !== "user" && role !== "guest") {
    return null;
  }
  const walletAddress =
    typeof payload.walletAddress === "string" && payload.walletAddress.trim()
      ? payload.walletAddress.trim()
      : typeof payload.sub === "string" && payload.sub.trim()
        ? payload.sub.trim()
        : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) return null;
  const tokenAddress =
    typeof payload.tokenAddress === "string" ? payload.tokenAddress : undefined;
  const expectedTokenAddress = process.env.TOKEN_CONTRACT_ADDRESS?.trim();
  if (
    expectedTokenAddress &&
    tokenAddress?.toLowerCase() !== expectedTokenAddress.toLowerCase()
  ) {
    return null;
  }
  const chainId =
    typeof payload.chainId === "number" ? payload.chainId : undefined;
  const expectedChainId = process.env.TOKEN_CHAIN_ID?.trim();
  if (expectedChainId && String(chainId ?? "") !== expectedChainId) {
    return null;
  }
  const cloudAgentId =
    typeof payload.cloudAgentId === "string" ? payload.cloudAgentId : undefined;
  const expectedCloudAgentId = (
    process.env.WAIFU_ELIZA_CLOUD_AGENT_ID ??
    process.env.ELIZA_CLOUD_AGENT_ID ??
    ""
  ).trim();
  if (expectedCloudAgentId && cloudAgentId !== expectedCloudAgentId) {
    return null;
  }

  return {
    role,
    walletAddress,
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(chainId !== undefined ? { chainId } : {}),
    ...(cloudAgentId ? { cloudAgentId } : {}),
    ...(typeof payload.balanceTokens === "number" ||
    payload.balanceTokens === null
      ? { balanceTokens: payload.balanceTokens as number | null }
      : {}),
  };
}

export function resolveWaifuChatAccess(
  req: http.IncomingMessage,
): WaifuChatAccess | null {
  return resolveWaifuChatAccessToken(extractAuthToken(req));
}

/**
 * Route allowlist for non-admin WaifuChat principals. Moved verbatim from the
 * trunk helper. Admins bypass this (they are authorized everywhere); only
 * `user`/`guest` principals are constrained to this set.
 */
function isWaifuChatScopedRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/health") return method === "GET";
  if (pathname === "/api/agents") return method === "GET";
  if (pathname === "/api/auth/status") return method === "GET";
  if (pathname === "/api/runtime-mode") return method === "GET";
  if (pathname === "/api/conversations") {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) {
    return method === "GET" || method === "POST";
  }
  if (/^\/api\/conversations\/[^/]+\/messages\/stream$/.test(pathname)) {
    return method === "POST";
  }
  if (/^\/api\/conversations\/[^/]+\/greeting$/.test(pathname)) {
    return method === "POST";
  }
  return false;
}

/**
 * Whether a request is authorized under the WaifuChat scheme. Preserved for
 * back-compat callers; the trunk gate now reaches this through the registered
 * resolver rather than importing it directly.
 */
export function isWaifuChatAuthorized(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
): boolean {
  const access = resolveWaifuChatAccess(req);
  if (!access) return false;
  if (access.role === "admin") return true;
  return isWaifuChatScopedRoute(method.toUpperCase(), pathname);
}

/** Map a validated {@link WaifuChatAccess} onto canonical boundary access. */
function toBoundaryAccess(access: WaifuChatAccess): BoundaryRoleAccess {
  return {
    providerId: WAIFU_CHAT_RESOLVER_ID,
    worldRole: waifuChatRoleToWorldRole(access.role),
    principal: access.walletAddress,
    isAdmin: access.role === "admin",
    isRouteInScope: isWaifuChatScopedRoute,
    claims: {
      role: access.role,
      walletAddress: access.walletAddress,
      ...(access.tokenAddress ? { tokenAddress: access.tokenAddress } : {}),
      ...(access.chainId !== undefined ? { chainId: access.chainId } : {}),
      ...(access.cloudAgentId ? { cloudAgentId: access.cloudAgentId } : {}),
      ...(access.balanceTokens !== undefined
        ? { balanceTokens: access.balanceTokens }
        : {}),
    },
  };
}

/**
 * The WaifuChat boundary-role resolver. Registering it wires the waifu role
 * scheme into the trunk gate through the extension point.
 */
export const waifuChatRoleResolver: TokenRoleResolver = {
  id: WAIFU_CHAT_RESOLVER_ID,
  resolve(req: http.IncomingMessage): BoundaryRoleAccess | null {
    const access = resolveWaifuChatAccess(req);
    return access ? toBoundaryAccess(access) : null;
  },
};

let unregister: (() => void) | null = null;

/**
 * Register the WaifuChat resolver with the trunk boundary-role registry.
 * Idempotent — safe to call from module load and from server setup.
 */
export function registerWaifuChatRoleResolver(): () => void {
  if (!unregister) {
    unregister = registerTokenRoleResolver(waifuChatRoleResolver);
  }
  return () => {
    unregister?.();
    unregister = null;
  };
}

// Self-register on import so any code path that touches the waifu resolver
// (server setup, conversation-routes) activates the scheme without the trunk
// auth helper having to know waifu exists.
registerWaifuChatRoleResolver();
