/**
 * Pins a transport request to one persistent session and revalidates its current
 * authority without refreshing activity on every frame. This authenticates the
 * actor only; callers still authorize conversation scope and each protected effect.
 */
import type { IncomingMessage } from "node:http";
import { ElizaError } from "@elizaos/core";
import type { AuthRepository } from "../../services/auth-store";
import {
  resolveSessionForRequest,
  sessionAllowedForRequest,
} from "./auth-context";
import {
  CSRF_HEADER_NAME,
  parseSessionCookie,
  readActiveSession,
  verifyCsrfToken,
} from "./sessions";
import { extractHeaderValue, getProvidedApiToken } from "./tokens";

export interface PersistentSessionActor {
  identityId: string;
  identityKind: "owner" | "machine";
  source: "cookie" | "bearer-session";
  scopes: readonly string[];
}

type PinnedSession = {
  sessionId: string;
  actor: Readonly<PersistentSessionActor>;
  origin: string | undefined;
  browserOrigin: string | null;
};

/** Origin admission is host-owned; ambient loopback/static/bootstrap authority is excluded. */
export function createPersistentSessionAdmission(input: {
  store: AuthRepository;
  allowedOrigins: readonly string[];
}) {
  const store = input.store;
  const origins = new Set(input.allowedOrigins);
  for (const origin of origins) {
    const url = URL.parse(origin);
    if (
      !url ||
      !["https:", "http:"].includes(url.protocol) ||
      url.origin !== origin
    ) {
      throw new ElizaError("Session admission requires exact HTTP(S) origins", {
        code: "SESSION_ADMISSION_ORIGIN_INVALID",
      });
    }
  }
  // Same-origin browser GETs omit Origin. Their Fetch Metadata plus the
  // exact admitted target host can establish the browser boundary for reads;
  // unsafe methods still require explicit Origin and the session CSRF token.
  function approvedBrowserOrigin(request: IncomingMessage): string | null {
    const origin = request.headers.origin;
    if (origin !== undefined) return origins.has(origin) ? origin : null;
    if (
      !["GET", "HEAD"].includes(request.method ?? "") ||
      request.headers["sec-fetch-site"] !== "same-origin"
    )
      return null;
    const host = request.headers.host;
    if (!host) return null;
    const matches = [...origins].filter(
      (entry) => new URL(entry).host === host.toLowerCase(),
    );
    return matches.length === 1 ? matches[0] : null;
  }

  const pinned = new WeakMap<IncomingMessage, PinnedSession | null>();

  async function revalidate(
    request: IncomingMessage,
  ): Promise<Readonly<PersistentSessionActor> | null> {
    const captured = pinned.get(request);
    if (!captured) return null;
    const credential =
      captured.actor.source === "cookie"
        ? parseSessionCookie(request)
        : getProvidedApiToken(request);
    if (
      credential !== captured.sessionId ||
      request.headers.origin !== captured.origin ||
      (captured.actor.source === "cookie" &&
        approvedBrowserOrigin(request) !== captured.browserOrigin)
    ) {
      pinned.set(request, null);
      return null;
    }
    const session = await readActiveSession(store, captured.sessionId);
    const identity = session
      ? await store.findIdentity(session.identityId)
      : null;
    if (
      !session ||
      !identity ||
      !sessionAllowedForRequest(session, request) ||
      session.scopes.length !== captured.actor.scopes.length ||
      session.scopes.some(
        (scope, index) => scope !== captured.actor.scopes[index],
      ) ||
      identity.id !== captured.actor.identityId ||
      identity.kind !== captured.actor.identityKind
    ) {
      pinned.set(request, null);
      return null;
    }
    return captured.actor;
  }

  async function capture(
    request: IncomingMessage,
  ): Promise<Readonly<PersistentSessionActor> | null> {
    if (pinned.has(request)) return revalidate(request);
    // A refused transport cannot be rebound to different credentials later.
    pinned.set(request, null);
    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      (typeof origin !== "string" || !origins.has(origin))
    )
      return null;
    const browserOrigin = approvedBrowserOrigin(request);
    if (parseSessionCookie(request) && browserOrigin === null) return null;
    const context = await resolveSessionForRequest(request, {
      store,
      allowBootstrapBearer: false,
      storeFailureMode: "throw",
    });
    if (
      !context?.session ||
      !context.identity ||
      context.source === "bearer-bootstrap"
    )
      return null;
    if (context.source === "cookie") {
      if (browserOrigin === null) return null;
      const method = request.method;
      if (!method) return null;
      if (
        !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
        !verifyCsrfToken(
          context.session,
          extractHeaderValue(request.headers[CSRF_HEADER_NAME]),
        )
      )
        return null;
    }
    const actor = Object.freeze({
      identityId: context.identity.id,
      identityKind: context.identity.kind,
      source: context.source,
      scopes: Object.freeze([...context.session.scopes]),
    });
    pinned.set(request, {
      sessionId: context.session.id,
      actor,
      origin,
      browserOrigin,
    });
    return actor;
  }

  return Object.freeze({ capture, revalidate });
}
