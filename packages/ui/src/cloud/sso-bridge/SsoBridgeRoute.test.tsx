/** Bare Network entry routing keeps the public app-origin login owner and PKCE/referrer gates. */
// @vitest-environment jsdom
import { STEWARD_TOKEN_KEY } from "@elizaos/plugin-elizacloud/steward-session-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appModeNavigation } from "../app-mode/app-mode";
import { SsoBridgeRoute } from "./SsoBridgeRoute";

const STATE = "a".repeat(64);
const CHALLENGE = "e".repeat(64);
const CODE = `esso_${"b".repeat(64)}`;
const realFetch = globalThis.fetch;
const realReplace = appModeNavigation.replace;
let fetchLog: Array<{ url: string; init?: RequestInit }>;
let replacedUrls: string[];
function liveToken(userId = "owned-user"): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}
function setReferrer(value: string): void {
  Object.defineProperty(document, "referrer", { value, configurable: true });
}
function stubNetwork(): void {
  fetchLog = [];
  replacedUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchLog.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, code: CODE }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  appModeNavigation.replace = (url) => {
    replacedUrls.push(url);
  };
}
function LocationProbe() {
  const location = useLocation();
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
    </span>
  );
}
function renderBridge(search: string): void {
  render(
    <MemoryRouter initialEntries={[`/auth/bridge${search}`]}>
      <Routes>
        <Route
          path="/auth/bridge"
          element={<SsoBridgeRoute hostname="eliza.app" />}
        />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}
const query = (returnTo: string) =>
  `?state=${STATE}&challenge=${CHALLENGE}&returnTo=${encodeURIComponent(returnTo)}`;
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
  appModeNavigation.replace = realReplace;
  setReferrer("");
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("bare Network phone entry through the public SSO route", () => {
  it("keeps a signed-out Network login on the paired app origin and lands at Join", async () => {
    setReferrer("https://cloud.eliza.app/");
    stubNetwork();
    renderBridge(query("/network/sign-in"));
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://cloud.eliza.app/network/sign-in?returnTo=%2Fjoin",
      ]),
    );
    expect(fetchLog).toEqual([]);
  });
  it("a cached unrelated account still reaches paired-app phone-only entry without minting", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken("unrelated-B"));
    stubNetwork();
    renderBridge(query("/network/sign-in"));
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://cloud.eliza.app/network/sign-in?returnTo=%2Fjoin",
      ]),
    );
    expect(fetchLog).toEqual([]);
  });

  it("the verified Join resume keeps normal challenge-bound minting", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken("phone-verified-A"));
    stubNetwork();
    renderBridge(query("/join"));
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        `https://cloud.eliza.app/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fjoin`,
      ]),
    );
    expect(JSON.parse(String(fetchLog[0].init?.body))).toEqual({
      codeChallenge: CHALLENGE,
    });
  });
  it.each([
    "/chat",
    "/cloud/billing",
    "/network/sign-in?networkSite=http://127.0.0.1:5102",
  ])(
    "keeps generic and parameterized login targets unchanged: %s",
    async (destination) => {
      setReferrer("https://cloud.eliza.app/");
      stubNetwork();
      renderBridge(query(destination));
      await waitFor(() =>
        expect(replacedUrls).toEqual([
          `https://cloud.eliza.app/login?returnTo=${encodeURIComponent(destination)}`,
        ]),
      );
      expect(fetchLog).toEqual([]);
    },
  );
  it.each(["", "https://evil.example/"])(
    "the Network entry never bypasses the referrer gate: %s",
    async (referrer) => {
      setReferrer(referrer);
      localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
      stubNetwork();
      renderBridge(query("/network/sign-in"));
      if (referrer)
        await waitFor(() =>
          expect(screen.getByTestId("location").textContent).toBe("/"),
        );
      else
        await waitFor(() =>
          expect(replacedUrls).toEqual([
            "https://cloud.eliza.app/login?returnTo=%2Fnetwork%2Fsign-in",
          ]),
        );
      expect(fetchLog).toEqual([]);
    },
  );
  it.each([
    `?challenge=${CHALLENGE}&returnTo=%2Fnetwork%2Fsign-in`,
    `?state=${STATE}&returnTo=%2Fnetwork%2Fsign-in`,
  ])(
    "the Network entry requires the existing nonce and challenge: %s",
    async (search) => {
      setReferrer("https://cloud.eliza.app/");
      localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
      stubNetwork();
      renderBridge(search);
      await waitFor(() =>
        expect(screen.getByTestId("location").textContent).toBe("/"),
      );
      expect(fetchLog).toEqual([]);
      expect(replacedUrls).toEqual([]);
    },
  );
});
