/** Real auth client, hook and persisted state; only the fetch boundary is controlled. */
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../api/client";
import { getBootConfig, setBootConfig } from "../config/boot-config-store";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "../first-run/mobile-runtime-mode";
import {
  getActiveProfile,
  upsertAndActivateAgentProfile,
} from "../state/agent-profiles";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../state/persistence";
import { STARTUP_TIMING_POLICY } from "../state/startup-timing-policy";
import { __resetAuthStatusForTests, useAuthStatus } from "./useAuthStatus";

const BASE = "https://paired-fixture.example";
const TOKEN = "fixture-paired-bearer";
const authenticated = {
  identity: { id: "owner", displayName: "Owner", kind: "owner" },
  session: { id: "paired-session", kind: "browser", expiresAt: null },
  access: {
    mode: "remote",
    role: "OWNER",
    passwordConfigured: true,
    ownerConfigured: true,
  },
};
const originalConfig = getBootConfig();
let available = false;
let fetchMock: ReturnType<typeof vi.fn>;

function storedState() {
  return Object.fromEntries(
    Object.keys(localStorage)
      .sort()
      .map((key) => [key, localStorage.getItem(key)]),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  available = false;
  setBootConfig({ branding: {}, apiBase: BASE, apiToken: TOKEN });
  client.setBaseUrl(BASE);
  client.setToken(TOKEN);
  upsertAndActivateAgentProfile({
    kind: "remote",
    label: "Saved host",
    apiBase: BASE,
    accessToken: TOKEN,
  });
  savePersistedActiveServer({
    id: "remote:fixture",
    kind: "remote",
    label: "Saved host",
    apiBase: BASE,
    accessToken: TOKEN,
  });
  savePersistedFirstRunComplete(true);
  localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "remote-mac");
  localStorage.setItem(
    "eliza:chat:activeConversationId",
    "original-conversation",
  );
  localStorage.setItem(
    "eliza:chat:draft:original-conversation",
    "Unsent owner draft",
  );
  sessionStorage.setItem("eliza:fixture-session", "retained-session-state");
  __resetAuthStatusForTests();
  fetchMock = vi.fn(async () => {
    if (!available) throw new TypeError("Failed to fetch: host offline");
    return new Response(JSON.stringify(authenticated), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  client.setBaseUrl(null);
  client.setToken(null);
  setBootConfig(originalConfig);
  __resetAuthStatusForTests();
});

it("reconnects after a real transport outage without losing the paired target, profile, history selection, draft or mode", async () => {
  const saved = storedState();
  const { result } = renderHook(() => useAuthStatus());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(result.current.state.phase).toBe("server_unavailable");
  expect(storedState()).toEqual(saved);
  expect(client.getBaseUrl()).toBe(BASE);
  expect(getBootConfig().apiToken).toBe(TOKEN);
  expect(loadPersistedActiveServer()?.accessToken).toBe(TOKEN);
  expect(getActiveProfile()?.accessToken).toBe(TOKEN);
  expect(sessionStorage.getItem("eliza:fixture-session")).toBe(
    "retained-session-state",
  );

  available = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(
      STARTUP_TIMING_POLICY.recoveryBaseDelayMs,
    );
  });
  expect(result.current.state.phase).toBe("authenticated");
  expect(storedState()).toEqual(saved);
  expect(getBootConfig().apiToken).toBe(TOKEN);
  for (const [url, options] of fetchMock.mock.calls) {
    expect(String(url)).toBe(`${BASE}/api/auth/me`);
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
  }
});

it("keeps a long outage on the same credential under capped backoff and stops scheduled recovery on unmount", async () => {
  const saved = storedState();
  const timers = vi.spyOn(window, "setTimeout");
  const { result, unmount } = renderHook(() => useAuthStatus());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(result.current.state.phase).toBe("server_unavailable");
  const calls = fetchMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(
      STARTUP_TIMING_POLICY.recoveryBaseDelayMs - 1,
    );
  });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_001);
  });
  expect(result.current.state.phase).toBe("server_unavailable");
  expect(storedState()).toEqual(saved);
  const failedCalls = fetchMock.mock.calls.length;
  // The second recovery is scheduled at 5s, after the first real probe's
  // existing 10s outage budget has settled. No overlapping 5-minute poll.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_999);
  });
  expect(fetchMock).toHaveBeenCalledTimes(failedCalls);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(180_001);
  });
  expect(result.current.state.phase).toBe("server_unavailable");
  expect(
    timers.mock.calls.some(
      ([, delay]) => delay === STARTUP_TIMING_POLICY.recoveryMaxDelayMs,
    ),
  ).toBe(true);
  expect(storedState()).toEqual(saved);
  const cappedCalls = fetchMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(
      STARTUP_TIMING_POLICY.recoveryMaxDelayMs - 1,
    );
  });
  expect(fetchMock).toHaveBeenCalledTimes(cappedCalls);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(cappedCalls);
  expect(storedState()).toEqual(saved);
  timers.mockRestore();
});

it("preserves explicit polling opt-out while keeping manual Retry available", async () => {
  const { result } = renderHook(() => useAuthStatus({ pollIntervalMs: 0 }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(result.current.state.phase).toBe("server_unavailable");
  const calls = fetchMock.mock.calls.length;
  available = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(calls);
  await act(async () => result.current.refetch());
  expect(result.current.state.phase).toBe("authenticated");
  expect(loadPersistedActiveServer()?.accessToken).toBe(TOKEN);
});
