/**
 * #9947 keystone — the embed session token is accepted as an API credential.
 *
 * `/api/embed/auth` mints a scoped, HMAC-signed bearer for the verified
 * OWNER/ADMIN principal of a cross-origin Telegram Mini App / Discord Activity
 * iframe (which cannot present the first-party session cookie). These tests pin
 * that the auth boundary now accepts that bearer — fail-closed on every bad
 * path — and that it is deliberately kept OUT of the sync sensitive/secrets
 * gate (`resolveBoundaryRole`), matching how normal sessions are excluded there.
 */

import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStore } from "../../services/auth-store";
import {
  _resetAuthRateLimiter,
  embedBoundaryRole,
  ensureCompatApiAuthorizedAsync,
  ensureCompatSensitiveRouteAuthorized,
  resolveEmbedPrincipal,
} from "../auth.ts";
import {
  mintEmbedSessionToken,
  resolveEmbedSessionSecret,
} from "./embed-session-token";

const SECRET = "embed-secret-at-least-16-chars-long";
const NOW = 1_000_000;
const ENTITY = "11111111-1111-1111-1111-111111111111";

// A store whose session lookups always miss, so the request falls through the
// cookie/session-bearer paths to the embed check. No real DB needed.
const noSessionStore = {
  findSession: async () => null,
  findIdentity: async () => null,
} as unknown as AuthStore;

// A remote (off-box) request — NOT trusted-local, so it must authenticate.
function remoteReq(
  headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = {
    host: "localhost:2138",
    "x-forwarded-for": "203.0.113.9",
    ...headers,
  };
  req.method = "GET";
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "203.0.113.9",
    configurable: true,
  });
  return req;
}

function bearer(token: string): http.IncomingHttpHeaders {
  return { authorization: `Bearer ${token}` };
}

function fakeRes() {
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.setHeader = () => res;
  res.end = (() => res) as typeof res.end;
  return res;
}

function validToken(
  overrides: Partial<Parameters<typeof mintEmbedSessionToken>[0]> = {},
) {
  return mintEmbedSessionToken(
    {
      entityId: ENTITY,
      role: "OWNER",
      adminMode: true,
      exp: NOW + 60_000,
      ...overrides,
    },
    SECRET,
  );
}

const ENV = ["ELIZA_EMBED_SESSION_SECRET", "ELIZA_API_TOKEN"] as const;
function clearEnv() {
  for (const k of ENV) delete process.env[k];
}

beforeEach(() => {
  clearEnv();
  _resetAuthRateLimiter();
});
afterEach(() => {
  clearEnv();
  _resetAuthRateLimiter();
  vi.restoreAllMocks();
});

describe("resolveEmbedSessionSecret", () => {
  it("prefers ELIZA_EMBED_SESSION_SECRET", () => {
    expect(
      resolveEmbedSessionSecret((k) =>
        k === "ELIZA_EMBED_SESSION_SECRET"
          ? SECRET
          : k === "ELIZA_API_TOKEN"
            ? "other-api-token-16chars"
            : undefined,
      ),
    ).toBe(SECRET);
  });

  it("falls back to ELIZA_API_TOKEN", () => {
    expect(
      resolveEmbedSessionSecret((k) =>
        k === "ELIZA_API_TOKEN" ? SECRET : undefined,
      ),
    ).toBe(SECRET);
  });

  it("treats a too-short value as unconfigured", () => {
    expect(resolveEmbedSessionSecret(() => "short")).toBeNull();
  });

  it("returns null when neither key is set", () => {
    expect(resolveEmbedSessionSecret(() => undefined)).toBeNull();
  });
});

describe("resolveEmbedPrincipal", () => {
  it("resolves a valid, unexpired token to its claims", () => {
    const claims = resolveEmbedPrincipal(
      remoteReq(bearer(validToken())),
      NOW,
      () => SECRET,
    );
    expect(claims).toMatchObject({ entityId: ENTITY, role: "OWNER" });
  });

  it("fails closed on a tampered token", () => {
    const token = `${validToken()}tamper`;
    expect(
      resolveEmbedPrincipal(remoteReq(bearer(token)), NOW, () => SECRET),
    ).toBeNull();
  });

  it("fails closed on an expired token", () => {
    const token = validToken({ exp: NOW - 1 });
    expect(
      resolveEmbedPrincipal(remoteReq(bearer(token)), NOW, () => SECRET),
    ).toBeNull();
  });

  it("fails closed when the secret is unconfigured", () => {
    expect(
      resolveEmbedPrincipal(
        remoteReq(bearer(validToken())),
        NOW,
        () => undefined,
      ),
    ).toBeNull();
  });

  it("fails closed when the token was signed with a different secret", () => {
    const token = mintEmbedSessionToken(
      { entityId: ENTITY, role: "OWNER", adminMode: true, exp: NOW + 60_000 },
      "a-totally-different-secret-16c",
    );
    expect(
      resolveEmbedPrincipal(remoteReq(bearer(token)), NOW, () => SECRET),
    ).toBeNull();
  });

  it("returns null when no bearer is present", () => {
    expect(resolveEmbedPrincipal(remoteReq(), NOW, () => SECRET)).toBeNull();
  });
});

describe("embedBoundaryRole", () => {
  it("maps OWNER→OWNER (no escalation)", () => {
    expect(
      embedBoundaryRole({
        entityId: ENTITY,
        role: "OWNER",
        adminMode: true,
        exp: NOW,
      }),
    ).toBe("OWNER");
  });
  it("maps ADMIN→USER (non-escalating; boundary has no ADMIN tier)", () => {
    expect(
      embedBoundaryRole({
        entityId: ENTITY,
        role: "ADMIN",
        adminMode: true,
        exp: NOW,
      }),
    ).toBe("USER");
  });
  it("returns null for no principal", () => {
    expect(embedBoundaryRole(null)).toBeNull();
  });
});

describe("ensureCompatApiAuthorizedAsync — embed token", () => {
  it("authorizes a remote request bearing a valid embed token", async () => {
    process.env.ELIZA_EMBED_SESSION_SECRET = SECRET;
    const ok = await ensureCompatApiAuthorizedAsync(
      remoteReq(bearer(validToken())),
      fakeRes(),
      { store: noSessionStore, now: NOW },
    );
    expect(ok).toBe(true);
  });

  it("rejects a tampered embed token (401)", async () => {
    process.env.ELIZA_EMBED_SESSION_SECRET = SECRET;
    const ok = await ensureCompatApiAuthorizedAsync(
      remoteReq(bearer(`${validToken()}x`)),
      fakeRes(),
      { store: noSessionStore, now: NOW },
    );
    expect(ok).toBe(false);
  });

  it("rejects an expired embed token (401)", async () => {
    process.env.ELIZA_EMBED_SESSION_SECRET = SECRET;
    const ok = await ensureCompatApiAuthorizedAsync(
      remoteReq(bearer(validToken({ exp: NOW - 1 }))),
      fakeRes(),
      { store: noSessionStore, now: NOW },
    );
    expect(ok).toBe(false);
  });

  it("rejects a valid-looking token when no embed secret is configured", async () => {
    // Token minted with SECRET, but the server has no secret set → cannot verify.
    const ok = await ensureCompatApiAuthorizedAsync(
      remoteReq(bearer(validToken())),
      fakeRes(),
      { store: noSessionStore, now: NOW },
    );
    expect(ok).toBe(false);
  });

  it("rejects an arbitrary non-embed bearer", async () => {
    process.env.ELIZA_EMBED_SESSION_SECRET = SECRET;
    const ok = await ensureCompatApiAuthorizedAsync(
      remoteReq(bearer("not-an-embed-token")),
      fakeRes(),
      { store: noSessionStore, now: NOW },
    );
    expect(ok).toBe(false);
  });
});

describe("embed is excluded from the sync sensitive gate", () => {
  it("does NOT authorize an embed token on the sync sensitive-route gate", () => {
    process.env.ELIZA_EMBED_SESSION_SECRET = SECRET;
    // Even a valid embed OWNER token must not satisfy the sync sensitive-route
    // boundary — that gate only trusts same-machine OWNERs. #12087 Item 29 made
    // the underlying resolveBoundaryRole/ensureMinRole helpers module-internal,
    // so this now asserts through the public ensureCompatSensitiveRouteAuthorized.
    const res = fakeRes();
    const authorized = ensureCompatSensitiveRouteAuthorized(
      remoteReq(bearer(validToken())),
      res,
    );
    expect(authorized).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
