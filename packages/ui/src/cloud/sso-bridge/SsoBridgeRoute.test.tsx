/** Behavioral contract for the /auth/bridge route component — role switching by injected hostname, the mint leg's session gate + code mint + cross-origin bounce, and the exchange leg's state-nonce verification before any network call — jsdom + real render, hand-rolled fetch/navigation stubs. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { appModeNavigation } from "../app-mode/app-mode";
import { SsoBridgeRoute } from "./SsoBridgeRoute";

const STATE = "a".repeat(64);
const OTHER_STATE = "c".repeat(64);
const CODE = `esso_${"b".repeat(64)}`;
const SSO_STATE_KEY = "eliza_sso_bridge_state";

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

describe("SsoBridgeRoute — mint leg (dashboard host)", () => {
  it("without a well-formed state nonce the visit is treated as any unknown path", () => {
    stubNetwork(() => json(500, {}));
    renderBridge("elizacloud.ai", "?returnTo=%2Fchat");
    expect(screen.getByTestId("home-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
  });

  it("signed out on the dashboard → straight to the APP host's own login", async () => {
    stubNetwork(() => json(500, {}));
    renderBridge("elizacloud.ai", `?state=${STATE}&returnTo=%2Fchat`);
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://app.elizacloud.ai/login?returnTo=%2Fchat",
      ]),
    );
    expect(fetchLog).toEqual([]);
  });

  it("signed in → mints with Bearer and bounces to the app exchange leg, state echoed", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork(() => json(200, { ok: true, code: CODE }));
    renderBridge("elizacloud.ai", `?state=${STATE}&returnTo=%2Fchat`);

    await waitFor(() =>
      expect(replacedUrls).toEqual([
        `https://app.elizacloud.ai/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
      ]),
    );
    expect(fetchLog[0].url).toBe(
      "https://api.elizacloud.ai/api/auth/sso-bridge/mint",
    );
  });

  it("mint failure → the app host's own login, never a loop back here", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork(() => json(503, { error: "sso_unavailable" }));
    renderBridge("elizacloud.ai", `?state=${STATE}&returnTo=%2Fchat`);
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://app.elizacloud.ai/login?returnTo=%2Fchat",
      ]),
    );
  });

  it("open-redirect returnTo collapses to /", async () => {
    stubNetwork(() => json(500, {}));
    renderBridge(
      "elizacloud.ai",
      `?state=${STATE}&returnTo=${encodeURIComponent("//evil.com")}`,
    );
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://app.elizacloud.ai/login?returnTo=%2F",
      ]),
    );
  });
});

describe("SsoBridgeRoute — exchange leg (app host)", () => {
  it("state mismatch aborts to the local login BEFORE any exchange call", async () => {
    sessionStorage.setItem(SSO_STATE_KEY, OTHER_STATE);
    stubNetwork(() => json(200, { ok: true, token: liveToken() }));
    renderBridge(
      "app.elizacloud.ai",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );

    expect((await screen.findByTestId("login-page")).textContent).toBe(
      "/login?returnTo=%2Fchat",
    );
    expect(fetchLog).toEqual([]);
    // The stored nonce was consumed either way — no second try with it.
    expect(sessionStorage.getItem(SSO_STATE_KEY)).toBeNull();
  });

  it("missing stored state (handshake this origin never initiated) aborts to login", async () => {
    stubNetwork(() => json(200, { ok: true, token: liveToken() }));
    renderBridge(
      "app.elizacloud.ai",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
  });

  it("malformed code aborts to login without a network call", async () => {
    sessionStorage.setItem(SSO_STATE_KEY, STATE);
    stubNetwork(() => json(200, { ok: true, token: liveToken() }));
    renderBridge(
      "app.elizacloud.ai",
      `?code=not-a-code&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(fetchLog).toEqual([]);
  });

  it("state match → exchanges the code, hydrates, lands on the sanitized returnTo", async () => {
    sessionStorage.setItem(SSO_STATE_KEY, STATE);
    const token = liveToken();
    stubNetwork((url) =>
      url.includes("/sso-bridge/exchange")
        ? json(200, { ok: true, token })
        : json(200, { ok: true }),
    );
    renderBridge(
      "app.elizacloud.ai",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );

    expect((await screen.findByTestId("landed")).textContent).toBe("/chat");
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
    expect(fetchLog[0].url).toBe(
      "https://api.elizacloud.ai/api/auth/sso-bridge/exchange",
    );
  });

  it("a denied exchange (replayed/expired code) falls back to the local login", async () => {
    sessionStorage.setItem(SSO_STATE_KEY, STATE);
    stubNetwork(() => json(401, { error: "invalid_code" }));
    renderBridge(
      "app.elizacloud.ai",
      `?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
    );
    expect(await screen.findByTestId("login-page")).toBeTruthy();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("open-redirect returnTo lands on / after a successful exchange", async () => {
    sessionStorage.setItem(SSO_STATE_KEY, STATE);
    stubNetwork((url) =>
      url.includes("/sso-bridge/exchange")
        ? json(200, { ok: true, token: liveToken() })
        : json(200, { ok: true }),
    );
    renderBridge(
      "app.elizacloud.ai",
      `?code=${CODE}&state=${STATE}&returnTo=${encodeURIComponent("//evil.com")}`,
    );
    expect(await screen.findByTestId("home-page")).toBeTruthy();
  });
});
