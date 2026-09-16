/** Exercises the real recovery hook, cookie refresh, session storage and pairing runner with HTTP-only fixtures. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { setBootConfig } from "../config/boot-config";
import { savePersistedActiveServer } from "../state/persistence";
import { useAgentSessionRecovery } from "./useAgentSessionRecovery";

vi.mock("./useAuthStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useAuthStatus")>()),
  useIsAuthenticated: () => false,
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const redirect = `https://${agentId}.elizacloud.ai/pair?token=synthetic-pair-token`;

function cookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: synthetic host marker for real cookie recovery.
  document.cookie = value;
}

describe("recovery hook cookie lifetime", () => {
  beforeEach(() => {
    localStorage.clear();
    cookie("steward-authed=1; Path=/");
    setBootConfig({ branding: {}, cloudApiBase: "https://api.eliza.app" });
    savePersistedActiveServer({
      id: `cloud:${agentId}`,
      kind: "cloud",
      label: "Test Agent",
      apiBase: `https://${agentId}.elizacloud.ai`,
      accessToken: "stale-agent-token",
    });
  });
  afterEach(() => {
    cleanup();
    cookie("steward-authed=; Max-Age=0; Path=/");
    localStorage.clear();
    setBootConfig({ branding: {} });
    vi.unstubAllGlobals();
  });

  it("does not cancel its own pairing continuation when cookie recovery publishes a token", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pairSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/auth/steward-refresh"))
        return Response.json({ token: "recovered-account-token" });
      if (url.endsWith("/pairing-token")) {
        pairSignal = init.signal;
        await held;
        return Response.json({ data: { redirectUrl: redirect } });
      }
      throw new Error("Unexpected fixture request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    const mounted = renderHook(() =>
      useAgentSessionRecovery({
        active: true,
        reason: "remote_auth_required",
        navigate,
      }),
    );
    try {
      await waitFor(() => expect(pairSignal).toBeDefined());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(pairSignal?.aborted).toBe(false);
      release();
      await waitFor(() => expect(navigate).toHaveBeenCalledWith(redirect));
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        "recovered-account-token",
      );
    } finally {
      release();
      mounted.unmount();
    }
  });

  it("starts a fresh attempt when reauthentication completes during cookie recovery", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/auth/steward-refresh")) {
        refreshSignal = init.signal;
        await held;
        return Response.json({ token: "obsolete-cookie-token" });
      }
      if (url.endsWith("/pairing-token")) {
        expect(new Headers(init.headers).get("Authorization")).toBe(
          "Bearer new-login-token",
        );
        return Response.json({ data: { redirectUrl: redirect } });
      }
      throw new Error("Unexpected fixture request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.fn();
    const mounted = renderHook(() =>
      useAgentSessionRecovery({
        active: true,
        reason: "remote_auth_required",
        navigate,
      }),
    );
    try {
      await waitFor(() => expect(refreshSignal).toBeDefined());
      act(() => {
        // A separate sign-in publisher replaces canonical storage and sends
        // the same notification as the native login bridge.
        localStorage.setItem(STEWARD_TOKEN_KEY, "new-login-token");
        window.dispatchEvent(new CustomEvent("steward-token-sync"));
      });
      await waitFor(() => expect(navigate).toHaveBeenCalledWith(redirect));
      expect(refreshSignal?.aborted).toBe(true);
      release();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("new-login-token");
      expect(navigate).toHaveBeenCalledOnce();
    } finally {
      release();
      mounted.unmount();
    }
  });

  it("finishes cookie recovery through the real in-process pairing commit without rearming itself", async () => {
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/steward-refresh"))
        return Response.json({ token: "cookie-account-token" });
      if (url.endsWith("/pairing-token"))
        return Response.json({ data: { redirectUrl: redirect } });
      if (url.endsWith("/api/auth/pair/native"))
        return Response.json({ apiKey: "cookie-paired-bearer", agentId });
      throw new Error("Unexpected fixture request");
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRecovered = vi.fn();
    const mounted = renderHook(() =>
      useAgentSessionRecovery({
        active: true,
        reason: "remote_auth_required",
        onRecovered,
      }),
    );
    try {
      await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(client.getRestAuthToken()).toBe("cookie-paired-bearer");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(onRecovered).toHaveBeenCalledOnce();
    } finally {
      mounted.unmount();
      client.setToken(null);
    }
  });

  it.each(["unmount", "pagehide", "target"])(
    "does not publish or pair after %s during cookie recovery",
    async (change) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchMock = vi.fn(async () => {
        await held;
        return Response.json({ token: "late-account-token" });
      });
      vi.stubGlobal("fetch", fetchMock);
      const navigate = vi.fn();
      const mounted = renderHook(() =>
        useAgentSessionRecovery({
          active: true,
          reason: "remote_auth_required",
          navigate,
        }),
      );
      try {
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        if (change === "unmount") mounted.unmount();
        else if (change === "pagehide")
          act(() => window.dispatchEvent(new Event("pagehide")));
        else
          savePersistedActiveServer({
            id: "remote:other",
            kind: "remote",
            label: "Other",
            apiBase: "https://other.example.com",
          });
        release();
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        release();
        mounted.unmount();
      }
    },
  );
});
