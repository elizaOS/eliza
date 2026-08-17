/**
 * Untrusted cookie-value encoding contract for `readCookie`.
 *
 * Session auth reads `eliza_session` via raw `decodeURIComponent`. A
 * malformed percent-escape (`%`, `%ZZ`, truncated UTF-8) therefore throws
 * URIError out of the helper and becomes a 500 at the HTTP boundary
 * instead of "no session cookie". Heavy auth-store / core imports are
 * mocked so this file can load in an isolated leftover-tax worktree;
 * `extractHeaderValue` is the real cookie-header split the helper uses.
 */

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";

vi.mock("@elizaos/core", () => ({
  roleRank: () => 0,
}));
vi.mock("@elizaos/shared", () => ({
  resolveApiToken: () => null,
}));
vi.mock("../services/auth-store.js", () => ({
  AuthStore: class AuthStore {},
}));
vi.mock("./auth/embed-session-token.js", () => ({
  readEmbedSessionSecretSetting: () => null,
  resolveEmbedSessionSecret: () => null,
  verifyEmbedSessionToken: () => null,
}));
vi.mock("./auth/sessions.js", () => ({
  CSRF_HEADER_NAME: "x-csrf",
  denyOnAuthStoreError: () => undefined,
  findActiveSession: async () => null,
  verifyCsrfToken: () => true,
}));
vi.mock("./auth/tokens.js", () => ({
  extractHeaderValue: (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value,
  getProvidedApiToken: () => null,
  tokenMatches: () => false,
}));
vi.mock("./compat-route-shared.js", () => ({
  isTrustedLocalRequest: () => false,
}));
vi.mock("./response.js", () => ({
  sendJsonError: () => undefined,
}));

import { readCookie } from "./auth.js";

function reqWithCookie(cookie: string): Pick<IncomingMessage, "headers"> {
  return { headers: { cookie } };
}

describe("readCookie path encoding", () => {
  it("returns null for a lone % session cookie before decode throws", () => {
    expect(readCookie(reqWithCookie("eliza_session=%"), "eliza_session")).toBe(
      null,
    );
  });

  it("returns null for %ZZ", () => {
    expect(
      readCookie(reqWithCookie("eliza_session=%ZZ"), "eliza_session"),
    ).toBe(null);
  });

  it("returns null for truncated UTF-8 %E0%A4%A", () => {
    expect(
      readCookie(reqWithCookie("eliza_session=%E0%A4%A"), "eliza_session"),
    ).toBe(null);
  });

  it("still decodes a valid %20 value", () => {
    expect(
      readCookie(reqWithCookie("eliza_session=launch%20pad"), "eliza_session"),
    ).toBe("launch pad");
  });

  it("returns null when the named cookie is absent", () => {
    expect(readCookie(reqWithCookie("other=1"), "eliza_session")).toBe(null);
  });
});
