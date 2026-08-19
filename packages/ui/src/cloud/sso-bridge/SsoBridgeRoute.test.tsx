/** Behavioral contract for the /auth/bridge route component — role switching by injected hostname, the mint leg's referrer gate + session gate + challenge-bound code mint + cross-origin bounce, and the exchange leg's state-nonce/verifier verification with burn-on-refusal — jsdom + real render, hand-rolled fetch/navigation stubs. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { appModeNavigation } from "../app-mode/app-mode";
import { SsoBridgeRoute } from "./SsoBridgeRoute";

const STATE = "a".repeat(64);
const OTHER_STATE = "c".repeat(64);
const CHALLENGE = "e".repeat(64);
const VERIFIER = "d".repeat(64);
const CODE = `esso_${"b".repeat(64)}`;
const SSO_STATE_KEY = "eliza_sso_bridge_state";
const SSO_VERIFIER_KEY = "eliza_sso_bridge_verifier";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function liveToken(): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }),
    "sig",
  ].join(".");
}

const realFetch = globalThis.fetch;
const realReplace = appModeNavigation.replace;
let fetchLog: { url: string; init: RequestInit | undefined }[];
let replacedUrls: string[];

function stubNetwork(responder: (url: string) => Response): void {
  fetchLog = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push({ url, init });
    return Promise.resolve(responder(url));
  }) as typeof fetch;
  replacedUrls = [];
  appModeNavigation.replace = (url: string) => {
    replacedUrls.push(url);
  };
}

/** jsdom's document.referrer is ""; the mint leg's gate reads it directly. */
function setReferrer(value: string): void {
  Object.defineProperty(document, "referrer", {
    value,
    configurable: true,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function LocationProbe({ id }: { id: string }): React.JSX.Element {
  const location = useLocation();
  return <div data-testid={id}>{`${location.pathname}${location.search}`}</div>;
}

function renderBridge(hostname: string, search: string): void {
  render(
    <MemoryRouter initialEntries={[`/auth/bridge${search}`]}>
      <Routes>
        <Route path="/login" element={<LocationProbe id="login-page" />} />
        <Route path="/" element={<LocationProbe id="home-page" />} />
        <Route
          path="/auth/bridge"
          element={<SsoBridgeRoute hostname={hostname} />}
        />
        <Route path="*" element={<LocationProbe id="landed" />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
  appModeNavigation.replace = realReplace;
  setReferrer("");
});

describe("SsoBridgeRoute — inert role", () => {
  it("localhost (dev) never participates: immediate local redirect home, no network", () => {
    stubNetwork(() => json(500, {}));
    renderBridge("localhost", `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`);
    expect(screen.getByTestId("home-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
    expect(replacedUrls).toEqual([]);
  });

  it("a per-agent subdomain never participates", () => {
    stubNetwork(() => json(500, {}));
    renderBridge("some-sandbox.elizacloud.ai", `?state=${STATE}`);
    expect(screen.getByTestId("home-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
  });
});

describe("SsoBridgeRoute — mint leg (eliza.app auth host)", () => {
  const MINT_QS = `?state=${STATE}&challenge=${CHALLENGE}&returnTo=%2Fchat`;

  it("without a well-formed state nonce the visit is treated as any unknown path", () => {
    setReferrer("https://cloud.eliza.app/");
    stubNetwork(() => json(500, {}));
    renderBridge("eliza.app", `?challenge=${CHALLENGE}&returnTo=%2Fchat`);
    expect(screen.getByTestId("home-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
  });

  it("without a well-formed challenge the visit is treated as any unknown path — no unbound codes", () => {
    setReferrer("https://cloud.eliza.app/");
    stubNetwork(() => json(500, {}));
    renderBridge("eliza.app", `?state=${STATE}&returnTo=%2Fchat`);
    expect(screen.getByTestId("home-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
  });

  it("an absent referrer falls back to app login without minting", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    setReferrer("");
    stubNetwork(() => json(200, { ok: true, code: CODE }));
    renderBridge("eliza.app", MINT_QS);

    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://cloud.eliza.app/login?returnTo=%2Fchat",
      ]),
    );
    expect(fetchLog).toEqual([]);
  });

  it("a cross-site referrer mints NOTHING — a third-party page cannot use eliza.app as a minting oracle", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    for (const referrer of ["https://evil.example/", "https://eliza.app/"]) {
      setReferrer(referrer);
      stubNetwork(() => json(200, { ok: true, code: CODE }));
      renderBridge("eliza.app", MINT_QS);
      expect(await screen.findByTestId("home-page")).toBeTruthy();
      expect(fetchLog).toEqual([]);
      expect(replacedUrls).toEqual([]);
      cleanup();
    }
  });

  it("signed out on eliza.app → the canonical login with the bridge leg preserved", async () => {
    setReferrer("https://cloud.eliza.app/");
    stubNetwork(() => json(500, {}));
    renderBridge("eliza.app", MINT_QS);
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        `/login?returnTo=${encodeURIComponent(`/auth/bridge?state=${STATE}&challenge=${CHALLENGE}&returnTo=%2Fchat`)}`,
      ]),
    );
    expect(fetchLog).toEqual([]);
  });

  it("signed in + app-initiated → mints with Bearer + challenge and bounces to the app exchange leg, state echoed, challenge NOT echoed", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork(() => json(200, { ok: true, code: CODE }));
    renderBridge("eliza.app", MINT_QS);

    await waitFor(() =>
      expect(replacedUrls).toEqual([
        `https://cloud.eliza.app/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
      ]),
    );
    expect(fetchLog[0].url).toBe("https://eliza.app/api/auth/sso-bridge/mint");
    expect(JSON.parse(String(fetchLog[0].init?.body))).toEqual({
      codeChallenge: CHALLENGE,
    });
  });

  it("mint failure → the app host's own login, never a loop back here", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork(() => json(503, { error: "sso_unavailable" }));
    renderBridge("eliza.app", MINT_QS);
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://cloud.eliza.app/login?returnTo=%2Fchat",
      ]),
    );
  });

  it("open-redirect returnTo collapses to /", async () => {
    setReferrer("https://cloud.eliza.app/");
    stubNetwork(() => json(500, {}));
    renderBridge(
      "eliza.app",
      `?state=${STATE}&challenge=${CHALLENGE}&returnTo=${encodeURIComponent("//evil.com")}`,
    );
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        `/login?returnTo=${encodeURIComponent(`/auth/bridge?state=${STATE}&challenge=${CHALLENGE}&returnTo=%2F`)}`,
      ]),
    );
  });
});

describe("SsoBridgeRoute — exchange leg (app host)", () => {
  function armHandshake(state: string = STATE): void {
    sessionStorage.setItem(SSO_STATE_KEY, state);
    sessionStorage.setItem(SSO_VERIFIER_KEY, VERIFIER);
  }

  /** The refusal paths burn the abandoned code: one verifier-less POST. */
  function expectBurnOnly(): void {
    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0].url).toBe(
      "https://cloud.eliza.app/api/auth/sso-bridge/exchange",
    );
    expect(JSON.parse(String(fetchLog[0].init?.body))).toEqual({ code: CODE });
  }

  it("state mismatch aborts to the local login — the code is never EXCHANGED, only burned", async () => {
    armHandshake(OTHER_STATE);
    stubNetwork(() => json(401, { error: "invalid_code" }));
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );

    expect((await screen.findByTestId("login-page")).textContent).toBe(
      "/login?returnTo=%2Fchat",
    );
    expectBurnOnly();
    // The stored nonce was consumed either way — no second try with it.
    expect(sessionStorage.getItem(SSO_STATE_KEY)).toBeNull();
    expect(sessionStorage.getItem(SSO_VERIFIER_KEY)).toBeNull();
  });

  it("missing stored state (handshake this origin never initiated) aborts to login and burns the code", async () => {
    stubNetwork(() => json(401, { error: "invalid_code" }));
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expectBurnOnly();
  });

  it("missing verifier (lost storage) aborts to login and burns the code instead of exchanging", async () => {
    sessionStorage.setItem(SSO_STATE_KEY, STATE);
    stubNetwork(() => json(401, { error: "invalid_code" }));
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expectBurnOnly();
  });

  it("malformed code aborts to login without ANY network call", async () => {
    armHandshake();
    stubNetwork(() => json(200, { ok: true, token: liveToken() }));
    renderBridge(
      "cloud.eliza.app",
      `?code=not-a-code&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
  });

  it("state match → exchanges code + verifier, hydrates, lands on the sanitized returnTo", async () => {
    armHandshake();
    const token = liveToken();
    stubNetwork((url) =>
      url.includes("/sso-bridge/exchange")
        ? json(200, { ok: true, token })
        : json(200, { ok: true }),
    );
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );

    expect((await screen.findByTestId("landed")).textContent).toBe("/chat");
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
    expect(fetchLog[0].url).toBe(
      "https://cloud.eliza.app/api/auth/sso-bridge/exchange",
    );
    expect(JSON.parse(String(fetchLog[0].init?.body))).toEqual({
      code: CODE,
      codeVerifier: VERIFIER,
    });
  });

  it("a denied exchange (replayed/expired code) falls back to the local login", async () => {
    armHandshake();
    stubNetwork(() => json(401, { error: "invalid_code" }));
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("open-redirect returnTo lands on / after a successful exchange", async () => {
    armHandshake();
    stubNetwork((url) =>
      url.includes("/sso-bridge/exchange")
        ? json(200, { ok: true, token: liveToken() })
        : json(200, { ok: true }),
    );
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${STATE}&returnTo=${encodeURIComponent("//evil.com")}`,
    );
    expect(await screen.findByTestId("home-page")).toBeTruthy();
  });
});
