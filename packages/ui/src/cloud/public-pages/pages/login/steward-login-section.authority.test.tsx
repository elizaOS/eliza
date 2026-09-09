/** Exercises the real login section, PKCE, HTTP session helpers and canonical commits with isolated HTTP fixtures, including a second session authority winning before commit. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  createStewardOAuthAuthorityBinding,
  getStewardTabSessionAuthorityCoordinator,
  readStoredStewardToken,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_ACTIVE_SCOPE_KEY,
  storeStewardPkceVerifier,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shell/CloudI18nProvider", () => {
  const translate = (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key;
  return { useCloudT: () => translate };
});

import { storePendingOAuthReturnTo } from "../../lib/login-return-to";
import StewardLoginSection from "./steward-login-section";

const token = `e30.${btoa(JSON.stringify({ userId: "login-fixture", tenantId: "elizacloud", exp: 4102444800 }))}.synthetic`;
let releaseExchange: (response: Response) => void;
let requests: string[];
let useFallback: boolean;
let requestSignal: AbortSignal | null | undefined;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  requests = [];
  useFallback = false;
  requestSignal = undefined;
  const pending = new Promise<Response>((resolve) => {
    releaseExchange = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/auth/steward-refresh" && useFallback)
        return Response.json({ ok: true, token });
      if (
        path === "/api/auth/steward-nonce-exchange" ||
        path === "/api/auth/steward-refresh"
      ) {
        requestSignal = init?.signal;
        return pending;
      }
      if (path === "/steward/auth/providers")
        return Response.json({
          passkey: false,
          email: true,
          siwe: false,
          siws: false,
          google: false,
          discord: false,
          github: false,
          twitter: false,
          oauth: [],
        });
      if (path === "/tenants/config") return Response.json({ ok: true });
      if (path === "/api/auth/steward-session")
        return Response.json({ ok: true });
      throw new Error(`Unexpected isolated HTTP request: ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom fixture exercises the browser cookie marker read by production recovery.
  document.cookie = "steward-authed=; Max-Age=0; path=/";
  window.history.replaceState(null, "", "/");
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

async function seedCallback(state = "synthetic-state", destination = "/chat") {
  const binding = await createStewardOAuthAuthorityBinding(
    getStewardTabSessionAuthorityCoordinator().readSnapshot(),
  );
  expect(
    storeStewardPkceVerifier("synthetic-verifier", state, binding, destination),
  ).toBe(true);
}

function Destination() {
  const location = useLocation();
  return (
    <>
      <h1>Authenticated destination fixture</h1>
      <output>{location.search}</output>
    </>
  );
}

async function mountCallback(
  mode: "nonce callback" | "cookie recovery",
  seed = true,
  strict = false,
  callbackUrl?: string,
) {
  const url =
    callbackUrl ??
    (mode === "nonce callback"
      ? "/login?code=synthetic-code&state=synthetic-state&returnTo=%2Fchat"
      : "/login?returnTo=%2Fchat");
  window.history.replaceState(null, "", url);
  if (mode === "nonce callback" && seed) await seedCallback();
  else if (mode === "cookie recovery") {
    // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; use the actual cookie marker boundary.
    document.cookie = "steward-authed=1; path=/";
  }
  const content = (
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/login" element={<StewardLoginSection />} />
        <Route path="/chat" element={<Destination />} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}

describe("OAuth provider roundtrip", () => {
  it.each(["A", "B"])(
    "preserves the conversation belonging to selected launch %s",
    async (selected) => {
      await seedCallback("state-A", "/chat?conversation=A");
      storePendingOAuthReturnTo(
        new URLSearchParams({ returnTo: "/chat?conversation=A" }),
      );
      const recordA = sessionStorage.getItem("steward.oauth.pkce.verifier");
      const intentA = sessionStorage.getItem("eliza.login.oauth.returnTo");
      await seedCallback("state-B", "/chat?conversation=B");
      storePendingOAuthReturnTo(
        new URLSearchParams({ returnTo: "/chat?conversation=B" }),
      );
      const recordB = localStorage.getItem("steward.oauth.pkce.verifier");
      if (!recordA || !intentA || !recordB)
        throw new Error("Missing simultaneous launch fixtures");
      sessionStorage.setItem("steward.oauth.pkce.verifier", recordA);
      sessionStorage.setItem("eliza.login.oauth.returnTo", intentA);
      await mountCallback(
        "nonce callback",
        false,
        true,
        `/login?code=synthetic-code&state=state-${selected}`,
      );
      await waitFor(() =>
        expect(requests).toContain("POST /api/auth/steward-nonce-exchange"),
      );
      await act(async () =>
        releaseExchange(Response.json({ ok: true, token })),
      );
      await screen.findByRole("heading", {
        name: "Authenticated destination fixture",
      });
      expect(screen.getByRole("status").textContent).toBe(
        `?conversation=${selected}`,
      );
      const otherStorage = selected === "A" ? localStorage : sessionStorage;
      expect(otherStorage.getItem("steward.oauth.pkce.verifier")).toBe(
        selected === "A" ? recordB : recordA,
      );
      expect(sessionStorage.getItem("eliza.login.oauth.returnTo")).toBe(
        intentA,
      );
    },
  );

  it.each(["valid token", "cookie only", "expired token"])(
    "does not race a fragment callback with passive recovery of %s",
    async (existing) => {
      if (existing === "valid token") await writeStoredStewardToken(token);
      if (existing === "expired token")
        await writeStoredStewardToken(
          `e30.${btoa(JSON.stringify({ userId: "expired-fixture", exp: 1 }))}.synthetic`,
        );
      if (existing === "cookie only") {
        // biome-ignore lint/suspicious/noDocumentCookie: real browser marker in the isolated jsdom fixture.
        document.cookie = "steward-authed=1; path=/";
      }
      await seedCallback();
      await mountCallback(
        "nonce callback",
        false,
        true,
        "/login#code=synthetic-code&state=synthetic-state",
      );
      await act(async () => {});
      expect(requests).not.toContain("POST /api/auth/steward-session");
      expect(requests).not.toContain("POST /api/auth/steward-refresh");
      await waitFor(() =>
        expect(requests).toContain("POST /api/auth/steward-nonce-exchange"),
      );
      expect(screen.getByText("Completing sign-in…")).toBeTruthy();
      await act(async () =>
        releaseExchange(Response.json({ ok: true, token })),
      );
      await screen.findByRole("heading", {
        name: "Authenticated destination fixture",
      });
      expect(
        requests.filter(
          (request) => request === "POST /api/auth/steward-nonce-exchange",
        ),
      ).toHaveLength(1);
      expect(readStoredStewardToken()).toBe(token);
    },
  );

  it.each(["logout", "replacement", "scope"])(
    "refuses an original launch after %s before dispatching the callback exchange",
    async (change) => {
      await seedCallback();
      if (change === "logout") await clearStoredStewardToken();
      if (change === "replacement")
        await writeStoredStewardToken("replacement-fixture");
      if (change === "scope")
        localStorage.setItem(STEWARD_ACTIVE_SCOPE_KEY, "different-target");
      await mountCallback("nonce callback", false);
      await act(async () =>
        releaseExchange(Response.json({ ok: true, token })),
      );
      await waitFor(() =>
        expect(screen.queryByText("Completing sign-in…")).toBeNull(),
      );
      expect(requests).not.toContain("POST /api/auth/steward-nonce-exchange");
      expect(readStoredStewardToken()).toBe(
        change === "replacement" ? "replacement-fixture" : null,
      );
      expect(screen.getByRole("alert")).toBeTruthy();
    },
  );

  it.each([
    ["nonce callback", "unmount"],
    ["nonce callback", "pagehide"],
    ["cookie recovery", "unmount"],
    ["cookie recovery", "pagehide"],
  ] as const)(
    "cancels %s abandoned by %s before late completion",
    async (mode, end) => {
      const view = await mountCallback(mode);
      await waitFor(() =>
        expect(requests).toContain(
          mode === "nonce callback"
            ? "POST /api/auth/steward-nonce-exchange"
            : "POST /api/auth/steward-refresh",
        ),
      );
      await act(async () => {
        if (end === "unmount") view.unmount();
        else fireEvent(window, new Event("pagehide"));
      });
      expect(requestSignal?.aborted).toBe(true);
      await act(async () =>
        releaseExchange(Response.json({ ok: true, token })),
      );
      expect(readStoredStewardToken()).toBeNull();
    },
  );

  it.each([false, true])(
    "starts fresh cookie recovery after page return (StrictMode: %s)",
    async (strict) => {
      await mountCallback("cookie recovery", true, strict);
      await waitFor(() => expect(requestSignal).toBeTruthy());
      const oldSignal = requestSignal;
      await act(async () => fireEvent(window, new Event("pagehide")));
      expect(oldSignal?.aborted).toBe(true);
      const staleToken = `e30.${btoa(JSON.stringify({ userId: "stale-fixture", tenantId: "elizacloud", exp: 4102444800 }))}.synthetic`;
      await act(async () =>
        releaseExchange(Response.json({ ok: true, token: staleToken })),
      );
      expect(readStoredStewardToken()).toBeNull();
      expect(
        screen.queryByRole("heading", {
          name: "Authenticated destination fixture",
        }),
      ).toBeNull();
      const beforeReturn = requests.filter(
        (request) => request === "POST /api/auth/steward-refresh",
      ).length;
      useFallback = true;
      await act(async () =>
        fireEvent(
          window,
          new PageTransitionEvent("pageshow", { persisted: true }),
        ),
      );
      await screen.findByRole("heading", {
        name: "Authenticated destination fixture",
      });
      expect(readStoredStewardToken()).toBe(token);
      expect(
        requests.filter(
          (request) => request === "POST /api/auth/steward-refresh",
        ),
      ).toHaveLength(beforeReturn + 1);
    },
  );

  it("completes exactly one callback under StrictMode", async () => {
    await mountCallback("nonce callback", true, true);
    await waitFor(() =>
      expect(requests).toContain("POST /api/auth/steward-nonce-exchange"),
    );
    await act(async () => releaseExchange(Response.json({ ok: true, token })));
    await screen.findByRole("heading", {
      name: "Authenticated destination fixture",
    });
    expect(
      requests.filter(
        (request) => request === "POST /api/auth/steward-nonce-exchange",
      ),
    ).toHaveLength(1);
    expect(readStoredStewardToken()).toBe(token);
  });

  it("keeps the callback loading state through StrictMode until the one-time exchange settles", async () => {
    await mountCallback("nonce callback", true, true);
    await waitFor(() =>
      expect(requests).toContain("POST /api/auth/steward-nonce-exchange"),
    );
    expect(screen.getByText("Completing sign-in…")).toBeTruthy();
    expect(screen.queryByPlaceholderText("you@example.com")).toBeNull();
    await act(async () => releaseExchange(Response.json({ ok: true, token })));
    await screen.findByRole("heading", {
      name: "Authenticated destination fixture",
    });
  });
});

describe.each(["nonce callback", "cookie recovery"] as const)(
  "login %s authority",
  (mode) => {
    const request =
      mode === "nonce callback"
        ? "POST /api/auth/steward-nonce-exchange"
        : "POST /api/auth/steward-refresh";
    it("persists an uninterrupted exchange and preserves the chat destination", async () => {
      await mountCallback(mode);
      await waitFor(() => expect(requests).toContain(request));
      await act(async () =>
        releaseExchange(Response.json({ ok: true, token })),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("heading", {
            name: "Authenticated destination fixture",
          }),
        ).toBeTruthy(),
      );
      expect(readStoredStewardToken()).toBe(token);
    });

    it.each([false, true])(
      "preserves authority across nonce cookie hydration (logout: %s)",
      async (logout) => {
        useFallback = true;
        await mountCallback("nonce callback");
        await waitFor(() =>
          expect(requests).toContain("POST /api/auth/steward-nonce-exchange"),
        );
        await act(async () => {
          const winner = logout ? clearStoredStewardToken() : Promise.resolve();
          releaseExchange(Response.json({ ok: true }));
          await winner;
        });
        if (logout) {
          await screen.findByPlaceholderText("you@example.com");
          expect(requests).not.toContain("POST /api/auth/steward-refresh");
          expect(readStoredStewardToken()).toBeNull();
        } else {
          await screen.findByRole("heading", {
            name: "Authenticated destination fixture",
          });
          expect(requests).toContain("POST /api/auth/steward-refresh");
          expect(readStoredStewardToken()).toBe(token);
        }
      },
    );

    it("cancels recovery transport on unmount and refuses its late result", async () => {
      const view = await mountCallback("cookie recovery");
      await waitFor(() =>
        expect(requests).toContain("POST /api/auth/steward-refresh"),
      );
      view.unmount();
      expect(requestSignal?.aborted).toBe(true);
      await act(async () =>
        releaseExchange(Response.json({ ok: true, token })),
      );
      expect(readStoredStewardToken()).toBeNull();
    });

    it.each(["logout", "replacement"] as const)(
      "does not publish a late callback after queued %s wins",
      async (change) => {
        await mountCallback(mode);
        await waitFor(() => expect(requests).toContain(request));
        await act(async () => {
          const winner =
            change === "logout"
              ? clearStoredStewardToken()
              : writeStoredStewardToken("replacement-fixture");
          releaseExchange(Response.json({ ok: true, token }));
          await winner;
        });
        await waitFor(() =>
          expect(screen.queryByText("Completing sign-in…")).toBeNull(),
        );
        expect(readStoredStewardToken()).toBe(
          change === "logout" ? null : "replacement-fixture",
        );
        expect(
          screen.queryByRole("heading", {
            name: "Authenticated destination fixture",
          }),
        ).toBeNull();
        await waitFor(() =>
          expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy(),
        );
        expect(screen.getByRole("alert").textContent).toContain(
          "Your session changed during sign-in. Please sign in again below.",
        );
      },
    );
  },
);
