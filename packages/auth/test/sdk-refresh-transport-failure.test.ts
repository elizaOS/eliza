import { expect, test, vi } from "vitest";
import { LoginAuth } from "../src/sdk/auth.ts";
import type { SessionStorage } from "../src/sdk/auth-types.ts";
import { LoginApiError } from "../src/sdk/transport.ts";

function storageWithRefreshToken(refreshToken: string): SessionStorage {
  const values = new Map<string, string>([
    ["steward_refresh_token", refreshToken],
  ]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("refreshSession rejects when the login API cannot be reached", async () => {
  const fetchMock = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
  vi.stubGlobal("fetch", fetchMock);

  const auth = new LoginAuth({
    baseUrl: "https://login.example.test",
    storage: storageWithRefreshToken("refresh-token-1"),
  });

  await expect(auth.refreshSession()).rejects.toBeInstanceOf(LoginApiError);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  vi.unstubAllGlobals();
});

test("refreshSession rejects when the login API fails without a token verdict", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({ ok: false, error: "upstream unavailable" }, 503),
    ),
  );

  const storage = storageWithRefreshToken("refresh-token-2");
  const auth = new LoginAuth({
    baseUrl: "https://login.example.test",
    storage,
  });

  await expect(auth.refreshSession()).rejects.toBeInstanceOf(LoginApiError);
  // The refresh token must survive a server outage: the credential is not invalid.
  expect(storage.getItem("steward_refresh_token")).toBe("refresh-token-2");

  vi.unstubAllGlobals();
});

test("refreshSession still resolves null when the refresh token is rejected", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({ ok: false, error: "invalid refresh token" }, 401),
    ),
  );

  const storage = storageWithRefreshToken("refresh-token-3");
  const auth = new LoginAuth({
    baseUrl: "https://login.example.test",
    storage,
  });

  await expect(auth.refreshSession()).resolves.toBeNull();
  expect(storage.getItem("steward_refresh_token")).toBeNull();

  vi.unstubAllGlobals();
});

test("refreshSession still resolves null when no refresh token is stored", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const auth = new LoginAuth({
    baseUrl: "https://login.example.test",
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });

  await expect(auth.refreshSession()).resolves.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();

  vi.unstubAllGlobals();
});

test("switchTenant keeps its documented best-effort null on transport failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );

  const auth = new LoginAuth({
    baseUrl: "https://login.example.test",
    storage: storageWithRefreshToken("refresh-token-4"),
  });

  await expect(auth.switchTenant("tenant-1")).resolves.toBeNull();

  vi.unstubAllGlobals();
});
