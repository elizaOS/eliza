/** Exercises the actual callback, runtime context, owned SDK and Cloud token commit with deterministic HTTP; no live provider is contacted. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  resetStewardTabSessionAuthorityCoordinatorForTests,
} from "@elizaos/shared/steward-session-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, StrictMode, useContext } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
} from "../../../shell/StewardProviderShared";

let currentAuth: LocalStewardAuthValue | null = null;
function ObserveAuth() {
  currentAuth = useContext(LocalStewardAuthContext);
  return null;
}

// Exclude unrelated wallet/rendered exports, not the provider or SDK under test.
vi.mock("../../../../login/index", async () => ({
  ...(await import("../../../../login/provider")),
  useAuth: (await import("../../../../login/hooks/useAuth")).useAuth,
}));
vi.mock("../../../../components/primitives", async () => ({
  Button: (await import("../../../../components/ui/button")).Button,
}));
// Replace only the lazy route gate so this test mounts the real runtime immediately.
vi.mock("../../../shell/StewardProvider", async () => {
  const shared = await import("../../../shell/StewardProviderShared");
  const Runtime = (await import("../../../shell/StewardProviderRuntime"))
    .default;
  return {
    ...shared,
    StewardAuthProvider: ({ children }: { children: ReactNode }) => (
      <Runtime apiUrl="https://login.example.test" tenantId="test-tenant">
        <ObserveAuth />
        {children}
      </Runtime>
    ),
  };
});
vi.mock("../../../shell/CloudI18nProvider", () => {
  const translate = (key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? key;
  return { useCloudT: () => translate };
});
vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import {
  consumePendingOAuthReturnTo,
  storePendingOAuthReturnTo,
} from "../../lib/login-return-to";
import EmailCallbackPage from "./email-callback-page";

let releaseVerification: (response: Response) => void;
let requests: string[];
let verificationSignal: AbortSignal | null | undefined;
let cloudSignal: AbortSignal | null | undefined;
let holdCloud: boolean;
let releaseCloud: (response: Response) => void;
let receipts: unknown[];
const token = `e30.${btoa(JSON.stringify({ userId: "callback-fixture", tenantId: "test-tenant", exp: 4102444800 }))}.synthetic`;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  currentAuth = null;
  requests = [];
  receipts = [];
  verificationSignal = undefined;
  cloudSignal = undefined;
  holdCloud = false;
  const cloud = new Promise<Response>((resolve) => {
    releaseCloud = resolve;
  });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      postMessage(message: unknown) {
        receipts.push(message);
      }
      close() {}
    },
  );
  const verification = new Promise<Response>((resolve) => {
    releaseVerification = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), window.location.origin).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/auth/email/verify") {
        verificationSignal = init?.signal;
        return (await verification).clone();
      }
      if (path === "/auth/providers")
        return Response.json({ ok: true, email: true });
      if (path === "/tenants/config") return Response.json({ ok: true });
      if (path === "/auth/tenants")
        return Response.json({ ok: true, tenants: [] });
      if (path === "/api/auth/steward-session") {
        cloudSignal = init?.signal;
        return holdCloud ? cloud : Response.json({ ok: true });
      }
      throw new Error(`Unexpected isolated HTTP request: ${path}`);
    }),
  );
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    completeVerification();
    releaseCloud(Response.json({ ok: true }));
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  delete document.documentElement.dataset.emailCallbackDocument;
});

function completeVerification() {
  releaseVerification(
    Response.json({
      ok: true,
      token,
      refreshToken: "",
      user: { id: "callback-fixture" },
      expiresIn: 3600,
    }),
  );
}
function mountCallback(
  strict = false,
  callbackToken = `synthetic-${crypto.randomUUID()}`,
) {
  const content = (
    <MemoryRouter
      initialEntries={[
        `/auth/callback/email?token=${callbackToken}&email=fixture%40example.test`,
      ]}
    >
      <EmailCallbackPage />
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}

describe("hosted email callback authority", () => {
  it.each(["verification", "cloud sync"])(
    "preserves the original destination when another intent arrives during %s",
    async (stage) => {
      holdCloud = stage === "cloud sync";
      storePendingOAuthReturnTo(
        new URLSearchParams({ returnTo: "/chat?conversation=original" }),
      );
      mountCallback();
      await waitFor(() =>
        expect(requests).toContain("POST /auth/email/verify"),
      );
      if (holdCloud) {
        await act(async () => completeVerification());
        await waitFor(() =>
          expect(requests).toContain("POST /api/auth/steward-session"),
        );
      }
      storePendingOAuthReturnTo(
        new URLSearchParams({ returnTo: "/chat?conversation=newer" }),
      );
      await act(async () => {
        if (holdCloud) releaseCloud(Response.json({ ok: true }));
        else completeVerification();
      });
      await screen.findByText("Signed in");
      expect(receipts).toEqual([
        expect.objectContaining({ destination: "/chat?conversation=original" }),
      ]);
      expect(consumePendingOAuthReturnTo()).toBe("/chat?conversation=newer");
    },
  );

  it("times out a verification and rejects its late result", async () => {
    vi.useFakeTimers();
    await act(async () => {
      mountCallback();
    });
    expect(requests).toContain("POST /auth/email/verify");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(verificationSignal?.aborted).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(
      /too long.*start sign-in again/i,
    );
    await act(async () => completeVerification());
    expect(readStoredStewardToken()).toBeNull();
    expect(receipts).toEqual([]);
    expect(requests).not.toContain("POST /api/auth/steward-session");
  });

  it.each([
    ["verification", "unmount"],
    ["verification", "pagehide"],
    ["cloud sync", "unmount"],
    ["cloud sync", "pagehide"],
  ])(
    "cancels %s on %s without a late canonical session or completion receipt",
    async (stage, end) => {
      holdCloud = stage === "cloud sync";
      const view = mountCallback();
      await waitFor(() =>
        expect(requests).toContain("POST /auth/email/verify"),
      );
      if (holdCloud) {
        await act(async () => completeVerification());
        await waitFor(() =>
          expect(requests).toContain("POST /api/auth/steward-session"),
        );
      }
      expect(currentAuth?.isAuthenticated).toBe(false);
      await act(async () => {
        if (end === "unmount") view.unmount();
        else fireEvent(window, new Event("pagehide"));
      });
      expect((holdCloud ? cloudSignal : verificationSignal)?.aborted).toBe(
        true,
      );
      await act(async () => {
        if (holdCloud) releaseCloud(Response.json({ ok: true }));
        else completeVerification();
      });
      expect(readStoredStewardToken()).toBeNull();
      expect(currentAuth?.isAuthenticated).toBe(false);
      expect(receipts).toEqual([]);
      if (!holdCloud)
        expect(requests).not.toContain("POST /api/auth/steward-session");
    },
  );

  it("retires a page-hidden callback and shows fresh-sign-in recovery on restoration", async () => {
    mountCallback();
    await waitFor(() => expect(requests).toContain("POST /auth/email/verify"));
    await act(async () => fireEvent(window, new Event("pagehide")));
    expect(verificationSignal?.aborted).toBe(true);
    await act(async () => completeVerification());
    fireEvent(window, new Event("pageshow"));
    expect(readStoredStewardToken()).toBeNull();
    expect(currentAuth?.isAuthenticated).toBe(false);
    expect(receipts).toEqual([]);
    expect(screen.getByRole("alert").textContent).toMatch(
      /start sign-in again/i,
    );
    expect(screen.getByRole("link", { name: "Back to login" })).toBeTruthy();
  });

  it.each(["StrictMode", "provider remount"])(
    "completes one verification and cookie transaction through %s",
    async (mode) => {
      holdCloud = true;
      const callbackToken = `synthetic-${crypto.randomUUID()}`;
      const view = mountCallback(mode === "StrictMode", callbackToken);
      await waitFor(() =>
        expect(requests).toContain("POST /auth/email/verify"),
      );
      await act(async () => completeVerification());
      await waitFor(() =>
        expect(requests).toContain("POST /api/auth/steward-session"),
      );
      expect(currentAuth?.isAuthenticated).toBe(false);
      if (mode === "provider remount") {
        view.unmount();
        mountCallback(false, callbackToken);
      }
      expect(screen.getByText("Verifying sign-in link...")).toBeTruthy();
      await act(async () => releaseCloud(Response.json({ ok: true })));
      await screen.findByText("Signed in");
      expect(readStoredStewardToken()).toBe(token);
      expect(currentAuth?.isAuthenticated).toBe(true);
      expect(
        requests.filter((r) => r === "POST /auth/email/verify"),
      ).toHaveLength(1);
      expect(
        requests.filter((r) => r === "POST /api/auth/steward-session"),
      ).toHaveLength(1);
      expect(receipts).toHaveLength(1);
    },
  );

  it("establishes the Cloud token after an uninterrupted SDK verification", async () => {
    mountCallback();
    await waitFor(() => expect(requests).toContain("POST /auth/email/verify"));
    await act(async () => completeVerification());
    await waitFor(() => expect(readStoredStewardToken()).toBe(token));
    expect(requests).toContain("POST /api/auth/steward-session");
    expect(currentAuth?.isAuthenticated).toBe(true);
  });

  it.each(["verification", "cloud sync", "remounted cloud sync"])(
    "keeps a pending callback signed out after acknowledged context sign-out during %s",
    async (stage) => {
      holdCloud = stage !== "verification";
      const callbackToken = `synthetic-${crypto.randomUUID()}`;
      const view = mountCallback(false, callbackToken);
      await waitFor(() =>
        expect(requests).toContain("POST /auth/email/verify"),
      );
      if (holdCloud) {
        await act(async () => completeVerification());
        await waitFor(() =>
          expect(requests).toContain("POST /api/auth/steward-session"),
        );
      }
      if (stage === "remounted cloud sync") {
        view.unmount();
        mountCallback(false, callbackToken);
      }
      expect(currentAuth).not.toBeNull();
      await act(async () => {
        if (!currentAuth) throw new Error("Runtime auth context did not mount");
        await currentAuth.signOut();
      });
      await act(async () => {
        if (holdCloud) releaseCloud(Response.json({ ok: true }));
        else completeVerification();
      });
      expect(readStoredStewardToken()).toBeNull();
      expect(currentAuth?.isAuthenticated).toBe(false);
      if (!holdCloud)
        expect(requests).not.toContain("POST /api/auth/steward-session");
      expect(receipts).toEqual([]);
      expect(screen.getByText("Sign-in failed")).toBeTruthy();
    },
  );

  it("rejects the Cloud commit when logout advances independently of the callback SDK", async () => {
    mountCallback();
    await waitFor(() => expect(requests).toContain("POST /auth/email/verify"));
    // A separate tab cannot increment this SDK instance's local epoch. It
    // does invalidate the shared generation while verification is pending.
    await act(async () => clearStoredStewardToken());
    await act(async () => completeVerification());
    expect(readStoredStewardToken()).toBeNull();
    expect(requests).not.toContain("POST /api/auth/steward-session");
    expect(screen.getByText("Sign-in failed")).toBeTruthy();
    expect(currentAuth?.isAuthenticated).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(
      /Your session changed.*Please start sign-in again/,
    );
  });
});
