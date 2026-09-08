/** Exercises the real hook, restore runner and authority with controlled HTTP/lock transports; subsequent backend polling is inert. */
// @vitest-environment jsdom

import {
  createStewardTabSessionAuthorityCoordinator,
  getStewardTabSessionAuthorityCoordinator,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
  StewardSessionAuthorityError,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { client } from "../api";
import {
  DEFAULT_BOOT_CONFIG,
  setBootConfig,
} from "../config/boot-config-store";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import {
  type StartupCoordinatorDeps,
  useStartupCoordinator,
} from "./useStartupCoordinator";

// The phase under test ends at polling. Keep later backend startup inert so it
// cannot perform unrelated transport or lifecycle work while repair is held.
vi.mock("./startup-phase-poll", () => ({ runPollingBackend: async () => {} }));

const agentId = "11111111-1111-4111-8111-111111111111";
const sharedBase = `https://api.eliza.app/api/v1/eliza/agents/${agentId}`;
const dedicatedBase = `https://${agentId}.cloud.eliza.app`;

beforeEach(() => {
  resetStewardTabSessionAuthorityCoordinatorForTests();
  localStorage.clear();
  sessionStorage.clear();
  setBootConfig(DEFAULT_BOOT_CONFIG);
  localStorage.setItem(STEWARD_TOKEN_KEY, "account-owner");
  savePersistedActiveServer({
    id: `cloud:${agentId}`,
    kind: "cloud",
    label: "Cloud",
    apiBase: `https://${agentId}.elizacloud.ai`,
  });
});
afterEach(() => {
  cleanup();
  resetStewardTabSessionAuthorityCoordinatorForTests();
  vi.unstubAllGlobals();
  client.setToken(null);
  client.setBaseUrl(null);
  localStorage.clear();
});

it.each(["phase-complete", "pagehide", "unmount"])(
  "owns delayed tier repair across %s",
  async (transition) => {
    let release!: () => void;
    let requested = false;
    let responded = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes(`/api/v1/eliza/agents/${agentId}`)) {
          requested = true;
          await held;
          responded = true;
          return new Response(
            JSON.stringify({
              success: true,
              data: { executionTier: "shared" },
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 503 });
      }),
    );
    // Only restoring-session deps are consumed; the subsequent polling phase is
    // explicitly inert above, not a fabricated successful backend.
    const deps = {
      setStartupError: vi.fn(),
      setAuthRequired: vi.fn(),
      setConnected: vi.fn(),
      setFirstRunOptions: vi.fn(),
      setFirstRunComplete: vi.fn(),
      setFirstRunLoading: vi.fn(),
      firstRunCompletionCommittedRef: { current: false },
      uiLanguage: "en",
    } as unknown as StartupCoordinatorDeps;
    const { result, unmount } = renderHook(() => useStartupCoordinator(deps));
    try {
      await waitFor(() => expect(result.current.phase).toBe("polling-backend"));
      expect(requested).toBe(true);
      expect(loadPersistedActiveServer()?.apiBase).toBe(dedicatedBase);
      if (transition === "unmount") unmount();
      if (transition === "pagehide")
        act(() => window.dispatchEvent(new Event("pagehide")));
      await act(async () => {
        release();
        await held;
      });
      await waitFor(() => expect(responded).toBe(true));
      if (transition === "phase-complete") {
        await waitFor(() =>
          expect(loadPersistedActiveServer()?.apiBase).toBe(sharedBase),
        );
        expect(client.getBaseUrl()).toBe(sharedBase);
      } else {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(loadPersistedActiveServer()?.apiBase).toBe(dedicatedBase);
        expect(client.getBaseUrl()).toBe(dedicatedBase);
      }
    } finally {
      release();
      unmount();
    }
  },
);

it.each(["churn", "unavailable", "timeout"])(
  "keeps a visible recovery boundary for %s instead of retrying indefinitely",
  async (failure) => {
    let grants = 0;
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: localStorage,
      lockManager: {
        request: async (_name, _options, callback) => {
          grants += 1;
          if (failure !== "churn") {
            throw new StewardSessionAuthorityError(
              "Lock transport failed",
              failure === "timeout"
                ? "STEWARD_SESSION_AUTHORITY_TIMEOUT"
                : "STEWARD_SESSION_AUTHORITY_UNAVAILABLE",
            );
          }
          // Emulate another origin context replacing authority before EACH
          // granted lease. The real coordinator rejects its captured snapshot.
          localStorage.setItem(STEWARD_TOKEN_KEY, `replacement-${grants}`);
          return callback();
        },
      },
    });
    resetStewardTabSessionAuthorityCoordinatorForTests(coordinator);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    const deps = {
      setStartupError: vi.fn(),
      setAuthRequired: vi.fn(),
      setConnected: vi.fn(),
      setFirstRunOptions: vi.fn(),
      setFirstRunComplete: vi.fn(),
      setFirstRunLoading: vi.fn(),
      firstRunCompletionCommittedRef: { current: false },
      uiLanguage: "en",
    } as unknown as StartupCoordinatorDeps;
    const { result, unmount } = renderHook(() => useStartupCoordinator(deps));
    try {
      await waitFor(() => expect(result.current.phase).toBe("error"));
      expect(grants).toBe(failure === "churn" ? 3 : 1);
      expect(deps.setStartupError).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "agent-error" }),
      );
    } finally {
      unmount();
    }
  },
);

it.each(["renewal", "selection", "pagehide", "unmount", "strictmode"])(
  "reconciles queued restoration after %s without painting a fatal error",
  async (transition) => {
    const originalBase = `https://${agentId}.cloud.eliza.app`;
    const replacementBase =
      "https://22222222-2222-4222-8222-222222222222.cloud.eliza.app";
    savePersistedActiveServer({
      id: `cloud:${agentId}`,
      kind: "cloud",
      label: "Cloud",
      apiBase: originalBase,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    let release!: () => void;
    let holding = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rotation = getStewardTabSessionAuthorityCoordinator().runExclusive({
      kind: "refresh",
      work: async (authority) => {
        holding = true;
        await gate;
        await writeStoredStewardToken("renewed-owner", { authority });
        if (transition === "selection") {
          savePersistedActiveServer({
            id: "cloud:22222222-2222-4222-8222-222222222222",
            kind: "cloud",
            label: "Selected Cloud",
            apiBase: replacementBase,
          });
        }
      },
    });
    await waitFor(() => expect(holding).toBe(true));
    const deps = {
      setStartupError: vi.fn(),
      setAuthRequired: vi.fn(),
      setConnected: vi.fn(),
      setFirstRunOptions: vi.fn(),
      setFirstRunComplete: vi.fn(),
      setFirstRunLoading: vi.fn(),
      firstRunCompletionCommittedRef: { current: false },
      uiLanguage: "en",
    } as unknown as StartupCoordinatorDeps;
    const { result, unmount } = renderHook(() => useStartupCoordinator(deps), {
      wrapper: transition === "strictmode" ? StrictMode : undefined,
    });
    try {
      // The real restore has captured the original authority and routed the
      // client, but its lease is queued behind the real concurrent rotation.
      await waitFor(() => expect(client.getBaseUrl()).toBe(originalBase));
      if (transition === "unmount") unmount();
      if (transition === "pagehide")
        act(() => window.dispatchEvent(new Event("pagehide")));
      await act(async () => {
        release();
        await rotation;
      });
      if (
        transition === "renewal" ||
        transition === "selection" ||
        transition === "strictmode"
      ) {
        await waitFor(() =>
          expect(result.current.phase).toBe("polling-backend"),
        );
        expect(client.getBaseUrl()).toBe(
          transition === "selection" ? replacementBase : originalBase,
        );
        expect(loadPersistedActiveServer()?.apiBase).toBe(
          transition === "selection" ? replacementBase : originalBase,
        );
      } else {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(result.current.phase).toBe("restoring-session");
        if (transition === "pagehide") {
          act(() => window.dispatchEvent(new Event("pageshow")));
          await waitFor(() =>
            expect(result.current.phase).toBe("polling-backend"),
          );
        }
      }
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("renewed-owner");
      expect(deps.setStartupError).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: "agent-error" }),
      );
    } finally {
      release();
      await rotation;
      unmount();
    }
  },
);
