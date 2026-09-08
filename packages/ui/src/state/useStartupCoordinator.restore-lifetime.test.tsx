/** Exercises the real hook, restore runner and detached tier repair; only HTTP and the subsequent polling phase are simulated. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
