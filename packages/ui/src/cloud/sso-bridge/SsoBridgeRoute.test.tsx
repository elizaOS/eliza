/** Behavioral contract for the /auth/bridge route component — role switching by injected hostname, the mint leg's referrer gate + session gate + challenge-bound code mint + cross-origin bounce, and the exchange leg's state-nonce/verifier verification with burn-on-refusal — jsdom + real render, hand-rolled fetch/navigation stubs. */
// @vitest-environment jsdom

import { locks } from "node:worker_threads";
import {
  clearStoredStewardToken,
  getStewardTabSessionAuthorityCoordinator,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import {
  MemoryRouter,
  type NavigateFunction,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appModeNavigation } from "../app-mode/app-mode";
import { SsoBridgeRoute } from "./SsoBridgeRoute";
import { createSsoBridgeHandshake } from "./sso-bridge";

const STATE = "a".repeat(64);
const OTHER_STATE = "c".repeat(64);
const CHALLENGE = "e".repeat(64);
const VERIFIER = "d".repeat(64);
const CODE = `esso_${"b".repeat(64)}`;
const SSO_STATE_KEY = "eliza_sso_bridge_state";
const SSO_VERIFIER_KEY = "eliza_sso_bridge_verifier";
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function liveToken(userId = "u1"): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({ userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
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

function NavigationCapture({
  capture,
}: {
  capture: (navigate: NavigateFunction) => void;
}): null {
  capture(useNavigate());
  return null;
}

function renderBridge(hostname: string, search: string, strict = false) {
  const route = (
    <MemoryRouter initialEntries={[`/auth/bridge${search}`]}>
      <Routes>
        <Route path="/login" element={<LocationProbe id="login-page" />} />
        <Route
          path="/auth/error"
          element={<LocationProbe id="auth-error-page" />}
        />
        <Route path="/" element={<LocationProbe id="home-page" />} />
        <Route
          path="/auth/bridge"
          element={<SsoBridgeRoute hostname={hostname} />}
        />
        <Route path="*" element={<LocationProbe id="landed" />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{route}</StrictMode> : route);
}

afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
  resetStewardTabSessionAuthorityCoordinatorForTests();
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.fetch = realFetch;
  appModeNavigation.replace = realReplace;
  setReferrer("");
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
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

  it("keeps a successful mint single-shot through StrictMode effect replay", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork((url) =>
      url.endsWith("/api/auth/sso-bridge/mint")
        ? json(200, { ok: true, code: CODE })
        : json(401, { error: "invalid_verifier" }),
    );

    render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/auth/bridge${MINT_QS}`]}>
          <Routes>
            <Route
              path="/auth/bridge"
              element={<SsoBridgeRoute hostname="eliza.app" />}
            />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() =>
      expect(replacedUrls).toEqual([
        `https://cloud.eliza.app/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fchat`,
      ]),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchLog).toHaveLength(1);
  });

  it.each(["unmount", "pagehide", "page-return"])(
    "burns an abandoned minted code after %s without replaying it on return",
    async (departure) => {
      setReferrer("https://cloud.eliza.app/");
      localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
      let resolveMint!: (response: Response) => void;
      fetchLog = [];
      globalThis.fetch = vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          fetchLog.push({ url, init });
          if (url.endsWith("/api/auth/sso-bridge/mint")) {
            return new Promise<Response>((resolve) => {
              resolveMint = resolve;
            });
          }
          return Promise.resolve(json(401, { error: "invalid_verifier" }));
        },
      ) as typeof fetch;
      replacedUrls = [];
      appModeNavigation.replace = (url: string) => {
        replacedUrls.push(url);
      };

      const view = render(
        <MemoryRouter initialEntries={[`/auth/bridge${MINT_QS}`]}>
          <Routes>
            <Route
              path="/auth/bridge"
              element={<SsoBridgeRoute hostname="eliza.app" />}
            />
          </Routes>
        </MemoryRouter>,
      );
      await waitFor(() => expect(fetchLog).toHaveLength(1));
      if (departure === "unmount") view.unmount();
      else act(() => window.dispatchEvent(new Event("pagehide")));
      await act(async () => {
        await Promise.resolve();
      });
      expect.soft(fetchLog[0].init?.signal?.aborted).toBe(true);
      if (departure === "page-return") {
        act(() => window.dispatchEvent(new Event("pageshow")));
        expect
          .soft(replacedUrls)
          .toEqual(["https://cloud.eliza.app/login?returnTo=%2Fchat"]);
      }

      await act(async () => {
        resolveMint(json(200, { ok: true, code: CODE }));
        await Promise.resolve();
      });

      expect(replacedUrls).toEqual(
        departure === "page-return"
          ? ["https://cloud.eliza.app/login?returnTo=%2Fchat"]
          : [],
      );
      await waitFor(() => expect(fetchLog).toHaveLength(2));
      expect(fetchLog[1].url).toBe(
        "https://eliza.app/api/auth/sso-bridge/burn",
      );
      expect(JSON.parse(String(fetchLog[1].init?.body))).toEqual({
        code: CODE,
      });
      if (departure === "pagehide") {
        act(() => window.dispatchEvent(new Event("pageshow")));
        expect(replacedUrls).toEqual([
          "https://cloud.eliza.app/login?returnTo=%2Fchat",
        ]);
        expect(fetchLog).toHaveLength(2);
      }
    },
  );

  it("burns a stale mint when the challenge changes and only hands off the current code", async () => {
    const nextChallenge = "f".repeat(64);
    const nextCode = `esso_${"c".repeat(64)}`;
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    const resolveMints: Array<(response: Response) => void> = [];
    fetchLog = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchLog.push({ url, init });
      if (url.endsWith("/api/auth/sso-bridge/mint")) {
        return new Promise<Response>((resolve) => {
          resolveMints.push(resolve);
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    replacedUrls = [];
    appModeNavigation.replace = (url: string) => {
      replacedUrls.push(url);
    };
    let navigate!: NavigateFunction;

    render(
      <MemoryRouter initialEntries={[`/auth/bridge${MINT_QS}`]}>
        <NavigationCapture
          capture={(capturedNavigate) => {
            navigate = capturedNavigate;
          }}
        />
        <Routes>
          <Route
            path="/auth/bridge"
            element={<SsoBridgeRoute hostname="eliza.app" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(resolveMints).toHaveLength(1));

    act(() => {
      navigate(
        `/auth/bridge?state=${OTHER_STATE}&challenge=${nextChallenge}&returnTo=%2Fchat`,
      );
    });
    await waitFor(() => expect(fetchLog[0].init?.signal?.aborted).toBe(true));
    expect(resolveMints).toHaveLength(1);
    // The old adapter ignores abort: do not overlap its authority with the new
    // request. Its late code must be burned before the next handshake proceeds.
    await act(async () => {
      resolveMints[0](json(200, { ok: true, code: CODE }));
    });
    await waitFor(() => expect(resolveMints).toHaveLength(2));

    await act(async () => {
      resolveMints[1](json(200, { ok: true, code: nextCode }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        `https://cloud.eliza.app/auth/bridge?code=${nextCode}&state=${OTHER_STATE}&returnTo=%2Fchat`,
      ]),
    );

    await waitFor(() =>
      expect(
        fetchLog.filter(({ url }) => url.endsWith("/sso-bridge/burn")),
      ).toHaveLength(1),
    );
    const burn = fetchLog.find(({ url }) => url.endsWith("/sso-bridge/burn"));
    expect(JSON.parse(String(burn?.init?.body))).toEqual({ code: CODE });
  });

  it("burns instead of handing off after logout and same-token restoration win the navigation queue", async () => {
    setReferrer("https://cloud.eliza.app/");
    const token = liveToken();
    await writeStoredStewardToken(token);
    const issued = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    stubNetwork(() => json(500, {}));
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchLog.push({ url, init });
      if (url.endsWith("/mint")) {
        entered.resolve();
        return issued.promise;
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;
    renderBridge("eliza.app", MINT_QS);
    await entered.promise;
    const logout = getStewardTabSessionAuthorityCoordinator().runExclusive({
      kind: "logout",
      work: async (authority) => {
        await clearStoredStewardToken({ authority });
        await writeStoredStewardToken(token, { authority });
      },
    });
    await act(async () => {
      issued.resolve(json(200, { code: CODE }));
      await logout;
    });
    await waitFor(() =>
      expect(replacedUrls).toEqual([
        "https://cloud.eliza.app/login?returnTo=%2Fchat",
      ]),
    );
    expect(fetchLog.filter(({ url }) => url.endsWith("/burn"))).toHaveLength(1);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
  });

  it("does not burn after a successful handoff is transferred and then unmounted", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork((url) =>
      url.endsWith("/api/auth/sso-bridge/mint")
        ? json(200, { ok: true, code: CODE })
        : new Response(null, { status: 204 }),
    );

    const view = render(
      <MemoryRouter initialEntries={[`/auth/bridge${MINT_QS}`]}>
        <Routes>
          <Route
            path="/auth/bridge"
            element={<SsoBridgeRoute hostname="eliza.app" />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(replacedUrls).toHaveLength(1));

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0].url).toBe("https://eliza.app/api/auth/sso-bridge/mint");
  });

  it("burns once and falls back to app login when code handoff navigation throws", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork((url) =>
      url.endsWith("/api/auth/sso-bridge/mint")
        ? json(200, { ok: true, code: CODE })
        : json(401, { error: "invalid_verifier" }),
    );
    const exchangeUrl = `https://cloud.eliza.app/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fchat`;
    appModeNavigation.replace = (url: string) => {
      replacedUrls.push(url);
      if (url === exchangeUrl) {
        throw new DOMException("Blocked", "SecurityError");
      }
    };

    renderBridge("eliza.app", MINT_QS);

    await waitFor(() =>
      expect(replacedUrls).toEqual([
        exchangeUrl,
        "https://cloud.eliza.app/login?returnTo=%2Fchat",
      ]),
    );
    expect(
      fetchLog.filter(({ url }) => url.endsWith("/sso-bridge/mint")),
    ).toHaveLength(1);
    expect(
      fetchLog.filter(({ url }) => url.endsWith("/sso-bridge/burn")),
    ).toHaveLength(1);
    expect(JSON.parse(String(fetchLog[1].init?.body))).toEqual({ code: CODE });
  });

  it("burns once and exposes an unexpected handoff failure distinctly", async () => {
    setReferrer("https://cloud.eliza.app/");
    localStorage.setItem(STEWARD_TOKEN_KEY, liveToken());
    stubNetwork((url) =>
      url.endsWith("/api/auth/sso-bridge/mint")
        ? json(200, { ok: true, code: CODE })
        : new Response(null, { status: 204 }),
    );
    appModeNavigation.replace = (url: string) => {
      replacedUrls.push(url);
      throw new Error("Unexpected navigation adapter failure");
    };

    renderBridge("eliza.app", MINT_QS);

    expect((await screen.findByTestId("auth-error-page")).textContent).toBe(
      "/auth/error?reason=auth_failed&returnTo=%2Fchat",
    );
    expect(
      fetchLog.filter(({ url }) => url.endsWith("/sso-bridge/burn")),
    ).toHaveLength(1);
    expect(JSON.parse(String(fetchLog[1].init?.body))).toEqual({ code: CODE });
  });

  it.each(["removed", "replaced"])(
    "burns the issued code if the minting session is %s while mint is pending",
    async (mutation) => {
      setReferrer("https://cloud.eliza.app/");
      const originalToken = liveToken();
      localStorage.setItem(STEWARD_TOKEN_KEY, originalToken);
      let resolveMint!: (response: Response) => void;
      const pendingMint = new Promise<Response>((resolve) => {
        resolveMint = resolve;
      });
      fetchLog = [];
      replacedUrls = [];
      globalThis.fetch = vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          fetchLog.push({ url, init });
          return url.endsWith("/mint")
            ? pendingMint
            : Promise.resolve(new Response(null, { status: 204 }));
        },
      ) as typeof fetch;
      appModeNavigation.replace = (url) => replacedUrls.push(url);
      renderBridge("eliza.app", MINT_QS);
      await waitFor(() => expect(fetchLog).toHaveLength(1));

      const nextToken = mutation === "replaced" ? liveToken("new-user") : null;
      if (nextToken) localStorage.setItem(STEWARD_TOKEN_KEY, nextToken);
      else localStorage.removeItem(STEWARD_TOKEN_KEY);
      await act(async () => resolveMint(json(200, { code: CODE })));

      await waitFor(() =>
        expect(replacedUrls).toEqual([
          "https://cloud.eliza.app/login?returnTo=%2Fchat",
        ]),
      );
      const burns = fetchLog.filter(({ url }) => url.endsWith("/burn"));
      expect(burns).toHaveLength(1);
      expect(JSON.parse(String(burns[0].init?.body))).toEqual({ code: CODE });
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(nextToken);
    },
  );

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
  it("completes a real stored handshake exactly once through StrictMode replay", async () => {
    const handshake = await createSsoBridgeHandshake();
    expect(handshake).not.toBeNull();
    const token = liveToken();
    stubNetwork((url) =>
      url.endsWith("/exchange")
        ? json(200, { token })
        : json(200, { ok: true }),
    );
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${handshake?.state}&returnTo=%2Fchat%3Fconversation%3Dfixture`,
      true,
    );
    expect((await screen.findByTestId("landed")).textContent).toBe(
      "/chat?conversation=fixture",
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(token);
    expect(
      fetchLog.filter(({ url }) => url.endsWith("/exchange")),
    ).toHaveLength(1);
    expect(
      fetchLog.filter(({ url }) => url.endsWith("/steward-session")),
    ).toHaveLength(1);
    expect(sessionStorage.getItem(SSO_STATE_KEY)).toBeNull();
    expect(sessionStorage.getItem(SSO_VERIFIER_KEY)).toBeNull();
  });

  it("rejects an original handshake after logout even when the token is absent again", async () => {
    const handshake = await createSsoBridgeHandshake();
    expect(handshake).not.toBeNull();
    await clearStoredStewardToken();
    stubNetwork(() => json(200, { token: liveToken() }));
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${handshake?.state}&returnTo=%2Fchat`,
    );
    expect((await screen.findByTestId("login-page")).textContent).toBe(
      "/login?returnTo=%2Fchat",
    );
    expect(fetchLog.filter(({ url }) => !url.endsWith("/burn"))).toEqual([]);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it.each(
    ["exchange", "steward-session"].flatMap((pendingEndpoint) =>
      ["unmount", "pagehide", "page-return"].map((departure) => ({
        pendingEndpoint,
        departure,
      })),
    ),
  )(
    "aborts $pendingEndpoint after $departure and preserves login intent without replay",
    async ({ pendingEndpoint, departure }) => {
      const handshake = await createSsoBridgeHandshake();
      expect(handshake).not.toBeNull();
      const token = liveToken();
      const pending = Promise.withResolvers<Response>();
      const entered = Promise.withResolvers<AbortSignal>();
      const synced = vi.fn();
      window.addEventListener("steward-token-sync", synced);
      stubNetwork(() => json(500, {}));
      globalThis.fetch = vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          fetchLog.push({ url, init });
          if (url.endsWith(`/${pendingEndpoint}`)) {
            if (!init?.signal)
              throw new Error("Missing transport cancellation");
            entered.resolve(init.signal);
            // Deliberately ignore abort to exercise a late adapter response.
            return pending.promise;
          }
          return Promise.resolve(json(200, { token }));
        },
      ) as typeof fetch;
      try {
        const view = renderBridge(
          "cloud.eliza.app",
          `?code=${CODE}&state=${handshake?.state}&returnTo=%2Fchat%3Fconversation%3Dfixture`,
        );
        const signal = await entered.promise;
        if (departure === "unmount") view.unmount();
        else act(() => window.dispatchEvent(new Event("pagehide")));
        await act(async () => {
          await Promise.resolve();
        });
        expect(signal.aborted).toBe(true);
        if (departure === "page-return") {
          act(() => window.dispatchEvent(new Event("pageshow")));
          expect((await screen.findByTestId("login-page")).textContent).toBe(
            "/login?returnTo=%2Fchat%3Fconversation%3Dfixture",
          );
        }
        await act(async () => {
          pending.resolve(json(200, { token, ok: true }));
          await getStewardTabSessionAuthorityCoordinator().runExclusive({
            kind: "session-sync",
            work: async () => {},
          });
        });
        expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
        expect(synced).not.toHaveBeenCalled();
        expect(replacedUrls).toEqual([]);
        expect(fetchLog).toHaveLength(pendingEndpoint === "exchange" ? 1 : 2);
        expect(screen.queryByTestId("landed")).toBeNull();
        if (departure === "pagehide") {
          expect(screen.queryByTestId("login-page")).toBeNull();
          act(() => window.dispatchEvent(new Event("pageshow")));
          expect((await screen.findByTestId("login-page")).textContent).toBe(
            "/login?returnTo=%2Fchat%3Fconversation%3Dfixture",
          );
          expect(fetchLog).toHaveLength(pendingEndpoint === "exchange" ? 1 : 2);
        }
      } finally {
        pending.resolve(json(200, { token }));
        window.removeEventListener("steward-token-sync", synced);
      }
    },
  );

  it("returns to login with the conversation intent when server session sync fails", async () => {
    const handshake = await createSsoBridgeHandshake();
    expect(handshake).not.toBeNull();
    stubNetwork((url) =>
      url.endsWith("/exchange")
        ? json(200, { token: liveToken() })
        : json(503, { error: "unavailable" }),
    );
    renderBridge(
      "cloud.eliza.app",
      `?code=${CODE}&state=${handshake?.state}&returnTo=%2Fchat%3Fconversation%3Dfixture`,
    );
    expect((await screen.findByTestId("login-page")).textContent).toBe(
      "/login?returnTo=%2Fchat%3Fconversation%3Dfixture",
    );
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(fetchLog).toHaveLength(2);
  });

  function armHandshake(state: string = STATE): void {
    const { generation, scope } =
      getStewardTabSessionAuthorityCoordinator().readSnapshot();
    sessionStorage.setItem(
      "eliza_sso_bridge_authority",
      JSON.stringify({ state, generation, scope }),
    );
    sessionStorage.setItem(SSO_STATE_KEY, state);
    sessionStorage.setItem(SSO_VERIFIER_KEY, VERIFIER);
  }

  /** The refusal paths burn the abandoned code: one verifier-less POST. */
  function expectBurnOnly(): void {
    expect(fetchLog).toHaveLength(1);
    expect(fetchLog[0].url).toBe(
      "https://cloud.eliza.app/api/auth/sso-bridge/burn",
    );
    expect(fetchLog[0].init?.keepalive).toBe(true);
    expect(JSON.parse(String(fetchLog[0].init?.body))).toEqual({ code: CODE });
  }

  it("removes the one-time code and nonce from browser history before exchange finishes", async () => {
    armHandshake();
    const callbackPath = `/auth/bridge?code=${CODE}&state=${STATE}&returnTo=%2Fchat`;
    window.history.replaceState(null, "", callbackPath);
    const replaceStateSpy = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => {});
    let strippedBeforeFetch = false;
    fetchLog = [];
    replacedUrls = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      strippedBeforeFetch = replaceStateSpy.mock.calls.length > 0;
      fetchLog.push({ url: String(input), init });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Abandoned fixture", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;

    renderBridge("cloud.eliza.app", callbackPath.slice("/auth/bridge".length));

    await waitFor(() => expect(fetchLog).toHaveLength(1));
    expect(replaceStateSpy).toHaveBeenCalledWith(
      window.history.state,
      "",
      "/auth/bridge?returnTo=%2Fchat",
    );
    expect(strippedBeforeFetch).toBe(true);
  });

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
