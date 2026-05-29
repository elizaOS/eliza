/**
 * API Authentication Middleware
 *
 * Authenticates requests using Steward-issued JWTs (HS256, issuer: "steward").
 * The JWT is read from the `steward-token` httpOnly cookie (preferred) or the
 * `Authorization: Bearer <token>` header (fallback for agents / external clients).
 *
 * User lookup chain (in order):
 *   1. Fast path:  WHERE stewardId = payload.userId
 *   2. Email bridge: unlinked user found by email → sets stewardId
 *   3. New user:   ensureUserFromSteward() creates the record
 *
 * Dev bypass: x-dev-user-id header OR dev-user:<userId> Bearer token.
 * Test DID:  steward:test:<userId> Bearer token (integration tests).
 */

import { and, db, eq, isNull, users } from "@feed/db";
import type { AuthenticatedUser } from "@feed/shared";
import { jwtVerify } from "jose";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyAgentSession } from "./agent-auth";
import {
  DEV_USER_ID_COOKIE_NAME,
  extractDevUserIdFromBearerToken,
} from "./dev-credentials";
import {
  AuthenticationError,
  isAuthenticationError,
  ServiceUnavailableError,
} from "./errors";
import { ensureUserFromSteward } from "./users/ensure-user";

export type { AuthenticatedUser } from "@feed/shared";
export { extractErrorMessage } from "@feed/shared";
export { AuthenticationError, isAuthenticationError };

// ─── Steward JWT verification ─────────────────────────────────────────────────

const STEWARD_INTERNAL_EMAIL_SUFFIX = "@id.steward.internal";

function getStewardJwtSecret(): Uint8Array {
  const secret = process.env.STEWARD_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new ServiceUnavailableError("STEWARD_JWT_SECRET is not configured");
    }
    // Dev fallback matches Steward's own dev default
    return new TextEncoder().encode("dev-jwt-secret-change-in-prod");
  }
  return new TextEncoder().encode(secret);
}

interface StewardJwtPayload {
  userId: string;
  tenantId?: string;
  email?: string;
  address?: string;
  fid?: number;
  telegramId?: string;
  [key: string]: unknown;
}

async function verifyStewardToken(token: string): Promise<StewardJwtPayload> {
  const { payload } = await jwtVerify(token, getStewardJwtSecret(), {
    issuer: "steward",
    algorithms: ["HS256"],
  });
  if (!payload.userId || typeof payload.userId !== "string") {
    throw new AuthenticationError("Steward JWT missing userId claim");
  }
  return payload as unknown as StewardJwtPayload;
}

// ─── User lookup chain ────────────────────────────────────────────────────────

const USER_SELECT = {
  id: users.id,
  stewardId: users.stewardId,
  privyId: users.privyId,
  email: users.email,
  isAdmin: users.isAdmin,
  isAgent: users.isAgent,
} as const;

async function resolveUserFromStewardPayload(
  payload: StewardJwtPayload,
): Promise<AuthenticatedUser> {
  const { userId: stewardUserId, email } = payload;

  // 1. Fast path: already linked
  const [byId] = await db
    .select(USER_SELECT)
    .from(users)
    .where(eq(users.stewardId, stewardUserId))
    .limit(1);

  if (byId) {
    return toAuthUser(byId);
  }

  // 2. Email bridge: Feed user exists but hasn't logged in via Steward yet.
  //    Only match on real emails — skip synthetic @id.steward.internal addresses.
  const isRealEmail =
    email &&
    typeof email === "string" &&
    !email.endsWith(STEWARD_INTERNAL_EMAIL_SUFFIX);

  if (isRealEmail) {
    const [byEmail] = await db
      .select(USER_SELECT)
      .from(users)
      .where(and(eq(users.email, email), isNull(users.stewardId)))
      .limit(1);

    if (byEmail) {
      await db
        .update(users)
        .set({ stewardId: stewardUserId })
        .where(eq(users.id, byEmail.id));
      return toAuthUser({ ...byEmail, stewardId: stewardUserId });
    }
  }

  // 3. New user: first-ever login via Steward for this user
  const newUser = await ensureUserFromSteward(
    stewardUserId,
    isRealEmail ? email : undefined,
  );
  return toAuthUser(newUser);
}

interface DbUserRow {
  id: string;
  stewardId: string | null;
  privyId: string | null;
  email: string | null;
  isAdmin: boolean;
  isAgent: boolean;
}

function toAuthUser(dbUser: DbUserRow): AuthenticatedUser {
  return {
    userId: dbUser.id,
    dbUserId: dbUser.id,
    stewardId: dbUser.stewardId ?? undefined,
    privyId: dbUser.privyId ?? dbUser.id,
    email: dbUser.email ?? undefined,
    isAdmin: dbUser.isAdmin,
    isAgent: dbUser.isAgent,
  };
}

// ─── authenticate ─────────────────────────────────────────────────────────────

export async function authenticate(
  request: NextRequest,
): Promise<AuthenticatedUser> {
  // ── Dev bypass: x-dev-user-id header / cookie ──────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const devUserId =
      request.headers.get("x-dev-user-id") ??
      request.cookies.get(DEV_USER_ID_COOKIE_NAME)?.value;
    if (devUserId) {
      const [dbUser] = await db
        .select(USER_SELECT)
        .from(users)
        .where(eq(users.id, devUserId))
        .limit(1);
      if (!dbUser) throw new AuthenticationError("Development user not found");
      return toAuthUser(dbUser);
    }
  }

  // ── Extract token ──────────────────────────────────────────────────────────
  // steward-token httpOnly cookie is preferred (set by POST /api/auth/session).
  // Authorization: Bearer falls back for agents and external API clients.
  const cookieToken = request.cookies.get("steward-token")?.value;
  const authHeader = request.headers.get("authorization");
  const headerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;
  const token = cookieToken ?? headerToken;

  if (!token) {
    throw new AuthenticationError("Missing authentication token");
  }

  // ── Dev Bearer: dev-user:<userId> ──────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const devBearerUserId = extractDevUserIdFromBearerToken(token);
    if (devBearerUserId) {
      const [dbUser] = await db
        .select(USER_SELECT)
        .from(users)
        .where(eq(users.id, devBearerUserId))
        .limit(1);
      if (!dbUser) throw new AuthenticationError("Development user not found");
      return toAuthUser(dbUser);
    }
  }

  // ── Integration test DID: steward:test:<userId> ────────────────────────────
  const allowTestAuth =
    process.env.ALLOW_TEST_STEWARD_AUTH !== undefined
      ? ["true", "1", "yes", "on"].includes(
          process.env.ALLOW_TEST_STEWARD_AUTH.toLowerCase(),
        )
      : process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test";

  if (allowTestAuth && token.startsWith("steward:test:")) {
    const embeddedUserId = token.slice("steward:test:".length);
    if (/^\d{15,20}$/.test(embeddedUserId)) {
      // Fast path — snowflake ID embedded directly
      return {
        userId: embeddedUserId,
        dbUserId: embeddedUserId,
        privyId: embeddedUserId,
        isAgent: false,
      };
    }
    const [dbUser] = await db
      .select(USER_SELECT)
      .from(users)
      .where(eq(users.id, embeddedUserId))
      .limit(1);
    if (!dbUser) throw new AuthenticationError("Test user not found");
    return toAuthUser(dbUser);
  }

  // ── Agent session token ────────────────────────────────────────────────────
  try {
    const agentSession = await verifyAgentSession(token);
    if (agentSession) {
      return {
        userId: agentSession.agentId,
        privyId: agentSession.agentId,
        isAgent: true,
      };
    }
  } catch {
    // Agent session lookup failed (e.g. Redis down) — fall through to Steward JWT
  }

  // ── Steward JWT verification ───────────────────────────────────────────────
  let payload: StewardJwtPayload;
  try {
    payload = await verifyStewardToken(token);
  } catch (err) {
    if (isAuthenticationError(err)) throw err;

    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (msg.includes("exp") || msg.includes("expired")) {
      throw new AuthenticationError(
        "Authentication token has expired. Please sign in again.",
      );
    }
    throw new AuthenticationError(
      "Invalid authentication token. Please sign in again.",
    );
  }

  return resolveUserFromStewardPayload(payload);
}

// ─── authenticateWithDbUser ───────────────────────────────────────────────────

export async function authenticateWithDbUser(
  request: NextRequest,
): Promise<AuthenticatedUser & { dbUserId: string }> {
  const authUser = await authenticate(request);
  if (!authUser.dbUserId) {
    throw new AuthenticationError(
      "User profile not found. Please complete onboarding first.",
    );
  }
  return authUser as AuthenticatedUser & { dbUserId: string };
}

// ─── optionalAuth ─────────────────────────────────────────────────────────────

export async function optionalAuth(
  request: NextRequest,
): Promise<AuthenticatedUser | null> {
  const cookieToken = request.cookies.get("steward-token")?.value;
  const authHeader = request.headers.get("authorization");
  const headerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;
  const token = cookieToken ?? headerToken;

  if (!token) return null;

  try {
    const agentSession = await verifyAgentSession(token);
    if (agentSession) {
      return {
        userId: agentSession.agentId,
        privyId: agentSession.agentId,
        isAgent: true,
      };
    }
  } catch {
    // fall through
  }

  try {
    const payload = await verifyStewardToken(token);
    return resolveUserFromStewardPayload(payload);
  } catch {
    return null;
  }
}

// ─── optionalAuthFromHeaders ──────────────────────────────────────────────────

export async function optionalAuthFromHeaders(
  headers: Headers,
): Promise<AuthenticatedUser | null> {
  const authHeader = headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  try {
    const agentSession = await verifyAgentSession(token);
    if (agentSession) {
      return { userId: agentSession.agentId, isAgent: true };
    }
  } catch {
    // fall through
  }

  try {
    const payload = await verifyStewardToken(token);
    return resolveUserFromStewardPayload(payload);
  } catch {
    return null;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

export function authErrorResponse(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function authenticateUser(req: NextRequest) {
  const authUser = await authenticate(req);
  return { id: authUser.userId, ...authUser };
}
