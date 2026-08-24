/** Proves the shared `useSessionAuth` hook resolves `{ ready, authenticated, user }` from each real session source through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Every branch of the canonical cloud session hook, driven through the real
 * module graph: the mounted Steward provider context, the persisted
 * localStorage JWT (decoded + expiry-checked by the real `decodeJwtPayload`),
 * the native cloud API-key session (`@capacitor/core` is doubled; Electrobun
 * detection runs for real via its window marker), the Playwright test-auth
 * bypass, source precedence, and the re-read listeners.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorState = { isNative: false };

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
}));

import { setBootConfig } from "../../config/boot-config";
import {
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
} from "../shell/StewardProviderShared";
import { useSessionAuth } from "./use-session-auth";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 600;

function setTestCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom must drive the browser marker cookie read by production.
  document.cookie = value;
}

function clearTestCookie(): void {
  setTestCookie(
    "eliza-test-auth=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/",
  );
}

function makeProviderAuth(overrides: {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: LocalStewardAuthValue["user"];
}): LocalStewardAuthValue {
  return {
    isAuthenticated: overrides.isAuthenticated,
    isLoading: overrides.isLoading,
    user: overrides.user,
    session: null,
    signOut: () => null,
    getToken: () => null,
    verifyEmailCallback: async () => ({ token: "" }),
  };
}

function renderSessionAuth(provider?: LocalStewardAuthValue) {
  return renderHook(() => useSessionAuth(), {
    wrapper: provider
      ? ({ children }) => (
          <LocalStewardAuthContext.Provider value={provider}>
            {children}
          </LocalStewardAuthContext.Provider>
        )
      : undefined,
  });
}

let storage: Storage;

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  capacitorState.isNative = false;
  Reflect.deleteProperty(window, "__electrobunWindowId");
  clearTestCookie();
  Reflect.deleteProperty(process.env, "NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH");
  setBootConfig({ branding: {}, apiToken: undefined });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useSessionAuth", () => {
  describe("mounted Steward provider", () => {
    it("exposes the provider user, authenticated, ready", () => {
      const { result } = renderSessionAuth(
        makeProviderAuth({
          isAuthenticated: true,
          isLoading: false,
          user: { id: "acct_1", walletAddress: "0xabc" },
        }),
      );

      expect(result.current.ready).toBe(true);
      expect(result.current.authenticated).toBe(true);
      expect(result.current.user).toEqual({
        id: "acct_1",
        email: "",
        walletAddress: "0xabc",
      });
    });

    it("maps a provider user without email or wallet address", () => {
      const { result } = renderSessionAuth(
        makeProviderAuth({
          isAuthenticated: true,
          isLoading: false,
          user: { id: "acct_2", email: "user@example.com" },
        }),
      );

      expect(result.current.user?.email).toBe("user@example.com");
      expect(result.current.user?.walletAddress).toBeUndefined();
    });

    it("the provider session outranks a persisted localStorage JWT", () => {
      storage.setItem(
        "steward_session_token",
        makeJwt({ userId: "jwt_user", exp: FUTURE_EXP }),
      );

      const { result } = renderSessionAuth(
        makeProviderAuth({
          isAuthenticated: true,
          isLoading: false,
          user: { id: "provider_user" },
        }),
      );

      expect(result.current.user?.id).toBe("provider_user");
    });

    it("is not ready while the provider is still loading", () => {
      const { result } = renderSessionAuth(
        makeProviderAuth({
          isAuthenticated: false,
          isLoading: true,
          user: null,
        }),
      );

      expect(result.current.ready).toBe(false);
      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });
  });

  describe("persisted JWT (page-reload reality: no provider mounted)", () => {
    it("is signed out and ready when no session source exists", () => {
      const { result } = renderSessionAuth();

      expect(result.current.ready).toBe(true);
      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("recovers the session from a valid non-expired JWT", () => {
      storage.setItem(
        "steward_session_token",
        makeJwt({
          userId: "u1",
          email: "u1@example.com",
          address: "0xdead",
          exp: FUTURE_EXP,
        }),
      );

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(true);
      expect(result.current.user).toEqual({
        id: "u1",
        email: "u1@example.com",
        walletAddress: "0xdead",
      });
    });

    it("falls back to the sub claim when userId is absent", () => {
      storage.setItem(
        "steward_session_token",
        makeJwt({ sub: "sub_user", exp: FUTURE_EXP }),
      );

      const { result } = renderSessionAuth();

      expect(result.current.user?.id).toBe("sub_user");
    });

    it("ignores a decodable JWT that carries neither userId nor sub", () => {
      storage.setItem(
        "steward_session_token",
        makeJwt({ email: "ghost@example.com", exp: FUTURE_EXP }),
      );

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("ignores an expired JWT", () => {
      storage.setItem(
        "steward_session_token",
        makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 600 }),
      );

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("reads an undecodable token as signed out instead of throwing", () => {
      storage.setItem("steward_session_token", "legacy-local-agent-bearer");

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("treats an empty stored token as signed out", () => {
      storage.setItem("steward_session_token", "");

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });
  });

  describe("re-read listeners", () => {
    it("picks up a sign-in written by another tab via the storage event", () => {
      const { result } = renderSessionAuth();
      expect(result.current.authenticated).toBe(false);

      storage.setItem(
        "steward_session_token",
        makeJwt({ userId: "late_signin", exp: FUTURE_EXP }),
      );
      act(() => {
        window.dispatchEvent(new Event("storage"));
      });

      expect(result.current.authenticated).toBe(true);
      expect(result.current.user?.id).toBe("late_signin");
    });

    it("drops the session when steward-token-sync fires after sign-out", () => {
      storage.setItem(
        "steward_session_token",
        makeJwt({ userId: "u1", exp: FUTURE_EXP }),
      );
      const { result } = renderSessionAuth();
      expect(result.current.authenticated).toBe(true);

      storage.removeItem("steward_session_token");
      act(() => {
        window.dispatchEvent(new CustomEvent("steward-token-sync"));
      });

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });
  });

  describe("native cloud API-key session", () => {
    it("builds a stable api-key identity from an eliza_ boot-config token", () => {
      capacitorState.isNative = true;
      setBootConfig({ branding: {}, apiToken: "eliza_native_owner_key" });

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(true);
      expect(result.current.user?.id).toMatch(/^native-api-key:/);
      expect(result.current.user?.email).toBe("");
      expect(renderSessionAuth().result.current.user?.id).toBe(
        result.current.user?.id,
      );
    });

    it("never mistakes the on-device agent bearer for a cloud session", () => {
      capacitorState.isNative = true;
      setBootConfig({ branding: {}, apiToken: "local-agent-bearer-token" });

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("ignores an eliza_ key when running on the web", () => {
      setBootConfig({ branding: {}, apiToken: "eliza_web_owner_key" });

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("detects the Electrobun desktop runtime via its real window marker", () => {
      (
        window as Window & { __electrobunWindowId?: number }
      ).__electrobunWindowId = 42;
      setBootConfig({ branding: {}, apiToken: "eliza_desktop_key" });

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(true);
      expect(result.current.user?.id).toMatch(/^native-api-key:/);
    });

    it("a live persisted JWT outranks the api-key session", () => {
      capacitorState.isNative = true;
      storage.setItem(
        "steward_session_token",
        makeJwt({ userId: "jwt_user", exp: FUTURE_EXP }),
      );
      setBootConfig({ branding: {}, apiToken: "eliza_native_owner_key" });

      const { result } = renderSessionAuth();

      expect(result.current.user?.id).toBe("jwt_user");
    });
  });

  describe("Playwright test-auth bypass", () => {
    it("stays off by default even when the marker cookie is present", () => {
      setTestCookie("eliza-test-auth=1");

      const { result } = renderSessionAuth();

      expect(result.current.authenticated).toBe(false);
      expect(result.current.user).toBeNull();
    });

    it("requires the marker cookie even when enabled", () => {
      process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH = "true";

      const { result } = renderSessionAuth();

      expect(result.current.user).toBeNull();
    });

    it("yields the fixed test user when enabled and marked", () => {
      process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH = "true";
      setTestCookie("eliza-test-auth=1");

      const { result } = renderSessionAuth();

      expect(result.current.ready).toBe(true);
      expect(result.current.authenticated).toBe(true);
      expect(result.current.user).toEqual({
        id: "22222222-2222-4222-8222-222222222222",
        email: "local-live-test-user@agent.local",
        walletAddress: undefined,
      });
    });

    it("is ready immediately while the provider loads when enabled", () => {
      process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH = "true";
      setTestCookie("eliza-test-auth=1");

      const { result } = renderSessionAuth(
        makeProviderAuth({
          isAuthenticated: false,
          isLoading: true,
          user: null,
        }),
      );

      expect(result.current.ready).toBe(true);
    });

    it("the api-key session outranks the test user when every source exists", () => {
      capacitorState.isNative = true;
      setBootConfig({ branding: {}, apiToken: "eliza_native_owner_key" });
      process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH = "true";
      setTestCookie("eliza-test-auth=1");

      const { result } = renderSessionAuth();

      expect(result.current.user?.id).toMatch(/^native-api-key:/);
    });
  });
});
