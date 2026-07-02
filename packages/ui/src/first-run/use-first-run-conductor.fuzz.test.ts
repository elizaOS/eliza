// @vitest-environment jsdom

// Confused-user fuzz for the in-chat first-run conductor: seeded random storms
// of valid, duplicated, out-of-order, and malformed picks — exactly what a
// user who doesn't understand the flow (or a flaky trackpad) produces. The
// REAL conductor + REAL finish use case run underneath; mocks sit only at the
// network boundary. Deterministic: every storm derives from a fixed seed, so a
// failure reproduces exactly.
//
// Invariants (the "rock solid" contract):
//   I1  POST /api/first-run fires at most once per onboarding session.
//   I2  At most one cloud provisioning call per session.
//   I3  completeFirstRun (the real gate flip) fires at most once.
//   I4  Every reserved-prefix value is consumed (never falls through to chat).
//   I5  The transcript stays bounded — no unbounded turn growth under spam.
//   I6  No unhandled rejection escapes (vitest fails the file if one does).

import { renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    listLocalAgentBackups: vi.fn(async () => []),
    restoreLocalAgentBackup: vi.fn(async () => undefined),
    getAuthStatus: vi.fn(async () => ({ required: false })),
    getCloudStatus: vi.fn(async () => ({ connected: true })),
    getCloudCompatAgents: vi.fn(async () => ({
      success: true as const,
      data: [] as unknown[],
    })),
    selectOrProvisionCloudAgent: vi.fn(
      async (_options: Record<string, unknown>) => ({
        apiBase: "https://agent.example.test",
        agentId: "agent-1",
        created: false,
      }),
    ),
    submitFirstRun: vi.fn(async () => undefined),
    getFirstRunStatus: vi.fn(async () => ({ complete: false })),
    getBaseUrl: vi.fn(() => ""),
    setBaseUrl: vi.fn(),
    setToken: vi.fn(),
    getRestAuthToken: vi.fn(() => null),
    fetch: vi.fn(async () => {
      throw new Error("no network in test");
    }),
  },
  autoDownloadRecommendedLocalModelInBackground: vi.fn(async () => undefined),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, client: mocks.client };
});

vi.mock("./auto-download-recommended", () => ({
  autoDownloadRecommendedLocalModelInBackground:
    mocks.autoDownloadRecommendedLocalModelInBackground,
}));

import type { ConversationMessage } from "../api";
import { __setAppValueForTests } from "../state/app-store";
import {
  ConversationMessagesCtx,
  type ConversationMessagesValue,
} from "../state/ConversationMessagesContext.hooks";
import type { AppContextValue } from "../state/internal";
import { tryHandleFirstRunAction } from "./first-run-action-channel";
import { useFirstRunConductor } from "./use-first-run-conductor";

function ensureLocalStorage(): Storage {
  if (typeof window.localStorage?.clear === "function") {
    return window.localStorage;
  }
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

interface AppStoreSpies {
  completeFirstRun: ReturnType<typeof vi.fn>;
}

function seedAppStore(): AppStoreSpies {
  const spies: AppStoreSpies = { completeFirstRun: vi.fn() };
  const fields: Record<string, unknown> = {
    firstRunComplete: false,
    firstRunName: "Eliza",
    elizaCloudConnected: true,
    uiLanguage: "en",
    completeFirstRun: spies.completeFirstRun,
    handleCloudLogin: vi.fn(async () => undefined),
    showActionBanner: vi.fn(),
    setTab: vi.fn(),
    setState: vi.fn(),
  };
  const noop = () => {};
  const value = new Proxy({} as AppContextValue, {
    get: (_target, prop) =>
      typeof prop === "string" && prop in fields ? fields[prop] : noop,
  });
  __setAppValueForTests(value);
  return spies;
}

function renderConductor() {
  const transcript: { current: ConversationMessage[] } = { current: [] };
  const value: ConversationMessagesValue = {
    conversationMessages: [],
    removeConversationMessage: () => {},
    setConversationMessages: (updater) => {
      transcript.current =
        typeof updater === "function" ? updater(transcript.current) : updater;
    },
  };
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(ConversationMessagesCtx.Provider, { value }, children);
  const utils = renderHook(() => useFirstRunConductor(), { wrapper });
  return { transcript, ...utils };
}

/** Deterministic PRNG (mulberry32) so every storm replays from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTION_POOL = [
  // Every legitimate pick, so storms cross flows out of order.
  "__first_run__:runtime:cloud",
  "__first_run__:runtime:local",
  // Retired option (chooser is now Cloud + On this device only) — kept in the
  // storm so a stale runtime:other widget is exercised; it must be consumed as
  // a no-op, never crash.
  "__first_run__:runtime:other",
  "__first_run__:provider:on-device",
  "__first_run__:provider:elizacloud",
  "__first_run__:provider:other",
  "__first_run__:cloud-agent:new",
  "__first_run__:cloud-agent:agent-1",
  "__first_run__:tutorial:start",
  "__first_run__:tutorial:skip",
  "__first_run__:backup-restore:latest",
  "__first_run__:backup-restore:start-fresh",
  // Malformed values under the reserved prefix.
  "__first_run__:",
  "__first_run__:runtime",
  "__first_run__:runtime:bogus",
  "__first_run__:provider:__proto__",
  "__first_run__:unknown:☃",
];

const STORM_STEPS = 250;

async function runStorm(opts: {
  seed: number;
  failCloud: boolean;
}): Promise<void> {
  const rand = mulberry32(opts.seed);
  if (opts.failCloud) {
    mocks.client.getCloudCompatAgents.mockImplementation(async () => {
      if (rand() < 0.5) throw new Error(`cloud flake (seed ${opts.seed})`);
      return { success: true as const, data: [] as unknown[] };
    });
  }
  const spies = seedAppStore();
  const { transcript, unmount } = renderConductor();
  await waitFor(() => {
    expect(
      transcript.current.some((turn) => turn.id === "first-run:greeting"),
    ).toBe(true);
  });

  for (let step = 0; step < STORM_STEPS; step += 1) {
    const value = ACTION_POOL[Math.floor(rand() * ACTION_POOL.length)];
    // I4: every reserved-prefix value is consumed by the active conductor.
    expect(tryHandleFirstRunAction(value), `step ${step}: ${value}`).toBe(true);
    if (rand() < 0.3) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  // Let every in-flight flow settle.
  await new Promise((resolve) => setTimeout(resolve, 100));

  // I1 — at most one POST /api/first-run.
  expect(
    mocks.client.submitFirstRun.mock.calls.length,
    `seed ${opts.seed}: POST /api/first-run count`,
  ).toBeLessThanOrEqual(1);
  // I2 — at most one cloud provisioning call.
  expect(
    mocks.client.selectOrProvisionCloudAgent.mock.calls.length,
    `seed ${opts.seed}: cloud provision count`,
  ).toBeLessThanOrEqual(1);
  // I3 — the real completion fires at most once.
  expect(
    spies.completeFirstRun.mock.calls.length,
    `seed ${opts.seed}: completeFirstRun count`,
  ).toBeLessThanOrEqual(1);
  // I5 — transcript stays bounded under 250 spam actions. Every seeded turn
  // has a stable id except error turns (one per settled failing flow, and a
  // failing flow needs a fresh user pick to start — far fewer than steps).
  expect(
    transcript.current.length,
    `seed ${opts.seed}: transcript size`,
  ).toBeLessThanOrEqual(40);
  // Sanity: nothing rendered a raw "undefined" into the transcript.
  for (const turn of transcript.current) {
    expect(turn.text).not.toContain("undefined");
  }
  unmount();
}

beforeEach(() => {
  ensureLocalStorage().clear();
  vi.clearAllMocks();
  mocks.client.listLocalAgentBackups.mockResolvedValue([]);
  mocks.client.getCloudCompatAgents.mockResolvedValue({
    success: true,
    data: [],
  });
  (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
    "cloud-token";
});

afterEach(() => {
  __setAppValueForTests(null);
  ensureLocalStorage().clear();
  delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
});

describe("first-run conductor fuzz storms", () => {
  for (const seed of [1337, 4242, 90210]) {
    it(`survives a ${STORM_STEPS}-step storm of random picks (seed ${seed})`, async () => {
      await runStorm({ seed, failCloud: false });
    });
  }

  for (const seed of [7, 555]) {
    it(`keeps its invariants when the cloud flakes mid-storm (seed ${seed})`, async () => {
      await runStorm({ seed, failCloud: true });
    });
  }
});
