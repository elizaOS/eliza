/** Verifies request-bound restrictions on persisted browser sessions. */

import http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type {
  AuthIdentityRow,
  AuthSessionRow,
  AuthStore,
} from "../../services/auth-store";
import {
  DESKTOP_LOOPBACK_SESSION_SCOPE,
  ensureSessionForRequest,
} from "./auth-context";
import { SESSION_COOKIE_NAME } from "./sessions";

const identity: AuthIdentityRow = {
  id: "owner-1",
  kind: "owner",
  displayName: "Local",
  createdAt: 1,
  passwordHash: null,
  cloudUserId: null,
};

function makeSession(scopes: string[]): AuthSessionRow {
  return {
    id: "session-1",
    identityId: identity.id,
    kind: "browser",
    createdAt: 1,
    lastSeenAt: 1,
    expiresAt: 100_000,
    rememberDevice: true,
    csrfSecret: "secret",
    ip: "127.0.0.1",
    userAgent: "test",
    scopes,
    revokedAt: null,
  };
}

function makeStore(session: AuthSessionRow): AuthStore {
  return {
    findSession: async (id: string) => (id === session.id ? session : null),
    findIdentity: async (id: string) => (id === identity.id ? identity : null),
    touchSession: async () => undefined,
  } as unknown as AuthStore;
}

function makeRequest(options: {
  remoteAddress: string;
  host: string;
  bearer?: boolean;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = options.bearer
    ? { authorization: "Bearer session-1", host: options.host }
    : { cookie: `${SESSION_COOKIE_NAME}=session-1`, host: options.host };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: options.remoteAddress,
    configurable: true,
  });
  return req;
}

async function resolve(session: AuthSessionRow, request: http.IncomingMessage) {
  return ensureSessionForRequest(request, new http.ServerResponse(request), {
    store: makeStore(session),
    now: 2,
    allowBootstrapBearer: false,
  });
}

describe("desktop loopback browser sessions", () => {
  it("accepts the marked session only from a loopback peer and Host", async () => {
    const session = makeSession([DESKTOP_LOOPBACK_SESSION_SCOPE]);
    await expect(
      resolve(
        session,
        makeRequest({ remoteAddress: "127.0.0.1", host: "127.0.0.1:31337" }),
      ),
    ).resolves.toMatchObject({ source: "cookie", identity });

    await expect(
      resolve(
        session,
        makeRequest({ remoteAddress: "203.0.113.5", host: "127.0.0.1:31337" }),
      ),
    ).resolves.toBeNull();
    await expect(
      resolve(
        session,
        makeRequest({ remoteAddress: "127.0.0.1", host: "example.test" }),
      ),
    ).resolves.toBeNull();
  });

  it("enforces the same restriction for bearer replay", async () => {
    await expect(
      resolve(
        makeSession([DESKTOP_LOOPBACK_SESSION_SCOPE]),
        makeRequest({
          remoteAddress: "203.0.113.6",
          host: "example.test",
          bearer: true,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("does not change ordinary browser-session routing", async () => {
    await expect(
      resolve(
        makeSession([]),
        makeRequest({ remoteAddress: "203.0.113.7", host: "example.test" }),
      ),
    ).resolves.toMatchObject({ source: "cookie", identity });
  });
});
