import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core/protocol", () => ({
  ElizaError: class extends Error {},
}));
vi.mock("../../src/cloud/shell/StewardProviderShared", () => ({
  clearStaleStewardSession: vi.fn(),
  configuredSessionEndpoint: vi.fn(),
}));
vi.mock("../../src/cloud/app-mode/app-mode", () => ({
  appModeNavigation: { replace: vi.fn() },
}));
vi.mock("../../src/surface-realm-channel", () => ({ shellLocalStorage: {} }));
vi.mock("../../src/utils/renderer-diagnostics", () => ({
  reportRendererDiagnostic: vi.fn(),
}));
vi.mock("@elizaos/plugin-elizacloud/steward-session-client", () => ({
  readStoredStewardToken: () => "owned-fresh-phone-token",
  writeStoredStewardToken: vi.fn(),
}));

import {
  isWellFormedSsoCode,
  mintSsoCode,
  parseNetworkSiteHandoff,
} from "../../src/cloud/sso-bridge/sso-bridge";

const hostname = "cloud-staging.eliza.app";
const state = "a".repeat(64);
const challenge = "b".repeat(64);
const destination = "http://127.0.0.1:54302";
const tuple = () =>
  new URLSearchParams({ networkSite: destination, state, challenge });

beforeEach(() => vi.clearAllMocks());

describe("staging Network phone continuation", () => {
  it("preserves the tuple while the existing account-switch owner retires the cookie", () => {
    const params = tuple();
    params.set("switchAccount", "1");
    const expected = { destination, state, challenge };
    expect(parseNetworkSiteHandoff(params, hostname)).toEqual(expected);
    params.delete("switchAccount");
    expect(parseNetworkSiteHandoff(params, hostname)).toEqual(expected);
    expect(
      parseNetworkSiteHandoff(
        new URLSearchParams({ returnTo: "/cloud/billing" }),
        hostname,
      ),
    ).toBeNull();
  });

  it("rejects malformed and non-staging navigation contexts before mint", async () => {
    const invalidOrigins = [
      "https://evil.example",
      "http://127.0.0.1:54302/",
      "http://user@127.0.0.1:54302",
      "http://127.0.0.1:54302/path",
      "http://127.0.0.1:54302?x=1",
      "http://127.0.0.1:54302#x",
      "javascript:alert(1)",
      "http://127.0.0.1.evil.example:54302",
    ];
    for (const value of invalidOrigins) {
      const params = tuple();
      params.set("networkSite", value);
      expect(() => parseNetworkSiteHandoff(params, hostname)).toThrow();
    }
    expect(() => parseNetworkSiteHandoff(tuple(), "cloud.eliza.app")).toThrow();
    expect(() => parseNetworkSiteHandoff(tuple(), "localhost")).toThrow();
    const missing = tuple();
    missing.delete("networkSite");
    expect(() => parseNetworkSiteHandoff(missing, hostname)).toThrow();
    const duplicate = tuple();
    duplicate.append("state", state);
    expect(() => parseNetworkSiteHandoff(duplicate, hostname)).toThrow();
    const bad = tuple();
    bad.set("challenge", "short");
    expect(() => parseNetworkSiteHandoff(bad, hostname)).toThrow();
    const returnTo = tuple();
    returnTo.set("returnTo", "https://evil.example");
    expect(() => parseNetworkSiteHandoff(returnTo, hostname)).toThrow();
    const fetchFn = vi.fn();
    const response = await mintSsoCode("cloud.eliza.app", challenge, fetchFn, {
      destination,
      state,
      challenge,
    });
    expect(response.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("extends the existing bearer mint with destination while keeping generic SSO codes separate", async () => {
    const calls: Array<{
      url: string;
      body: Record<string, string>;
      authorization: string | null;
    }> = [];
    let code = `enso_${"c".repeat(64)}`;
    const fetchFn = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ ok: true, code, expiresIn: 60 });
    }) as typeof fetch;
    const parsed = parseNetworkSiteHandoff(tuple(), hostname);
    if (!parsed) throw new Error("Expected valid Network fixture");
    expect(
      await mintSsoCode(
        hostname,
        challenge,
        fetchFn,
        parsed,
        "owned-fresh-phone-token",
      ),
    ).toEqual({
      ok: true,
      code,
    });
    expect(calls[0].body).toEqual({ codeChallenge: challenge, destination });
    expect(calls[0].authorization).toBe("Bearer owned-fresh-phone-token");
    expect(new URL(calls[0].url).hostname).not.toBe("127.0.0.1");
    expect(isWellFormedSsoCode(code)).toBe(false);
    expect(isWellFormedSsoCode(code, true)).toBe(true);
    code = `esso_${"d".repeat(64)}`;
    expect(
      (
        await mintSsoCode(
          hostname,
          challenge,
          fetchFn,
          parsed,
          "owned-fresh-phone-token",
        )
      ).ok,
    ).toBe(false);
    expect(
      (await mintSsoCode("staging.eliza.app", challenge, fetchFn)).ok,
    ).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ codeChallenge: challenge });
    expect(calls.every((call) => !call.url.startsWith(destination))).toBe(true);
    const beforeChangedSession = calls.length;
    expect(
      (
        await mintSsoCode(
          hostname,
          challenge,
          fetchFn,
          parsed,
          "different-session",
        )
      ).ok,
    ).toBe(false);
    expect((await mintSsoCode(hostname, challenge, fetchFn, parsed)).ok).toBe(
      false,
    );
    expect(calls).toHaveLength(beforeChangedSession);
  });
});
