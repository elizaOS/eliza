// @vitest-environment jsdom

// The in-chat first-run conductor, driven through its REAL public seams: the
// hook is mounted (registering its handler on the first-run action channel),
// picks arrive via `tryHandleFirstRunAction` exactly as the chat send funnel
// delivers them, and the REAL finish use case (`first-run-finish.ts`) runs
// underneath. Mocks sit only at the network boundary (the shared `client`
// singleton + the background model download).

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
    // Takes the provisioning options so `.mock.calls[0][0]` is inspectable.
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
import {
  type FirstRunFinishDraft,
  type FirstRunFinishPorts,
  resetFirstRunPersistGuard,
  runFirstRunFinish,
} from "./first-run-finish";
import {
  surfaceCloudLoginRetryTurn,
  useFirstRunConductor,
} from "./use-first-run-conductor";

// This jsdom env exposes `window.localStorage` as an object without methods;
// install a real in-memory Storage (mirrors `first-run.test.ts`) so the finish
// path's persisted-server/profile writes work.
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

function readTutorialState(): { active: boolean; stepIndex: number } {
  const store = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("elizaos.ui.tutorial-controller")
  ] as { state: { active: boolean; stepIndex: number } } | undefined;
  return store?.state ?? { active: false, stepIndex: 0 };
}

function resetTutorialState(): void {
  const store = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("elizaos.ui.tutorial-controller")
  ] as { state: { active: boolean; stepIndex: number } } | undefined;
  if (store) store.state = { active: false, stepIndex: 0 };
}

interface AppStoreSpies {
  completeFirstRun: ReturnType<typeof vi.fn>;
  handleCloudLogin: ReturnType<typeof vi.fn>;
  showActionBanner: ReturnType<typeof vi.fn>;
  setTab: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

/** Seed the app-store slice the conductor selects; everything else is inert. */
function seedAppStore(overrides: Record<string, unknown> = {}): AppStoreSpies {
  const spies: AppStoreSpies = {
    completeFirstRun: vi.fn(),
    handleCloudLogin: vi.fn(async () => undefined),
    showActionBanner: vi.fn(),
    setTab: vi.fn(),
    setState: vi.fn(),
  };
  const fields: Record<string, unknown> = {
    firstRunComplete: false,
    firstRunName: "Eliza",
    elizaCloudConnected: true,
    uiLanguage: "en",
    ...spies,
    ...overrides,
  };
  const noop = () => {};
  const value = new Proxy({} as AppContextValue, {
    get: (_target, prop) =>
      typeof prop === "string" && prop in fields ? fields[prop] : noop,
  });
  __setAppValueForTests(value);
  return spies;
}

/**
 * Mount the conductor inside a REAL (ref-backed) transcript provider so the
 * seeded onboarding turns are observable exactly as the overlay would render
 * them. `setConversationMessages` applies functional updaters for real.
 */
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
  const turn = (id: string): ConversationMessage | undefined =>
    transcript.current.find((message) => message.id === id);
  return { transcript, turn, ...utils };
}

async function waitForTurn(
  turn: (id: string) => ConversationMessage | undefined,
  id: string,
): Promise<ConversationMessage> {
  await waitFor(() => {
    expect(turn(id)).toBeTruthy();
  });
  const found = turn(id);
  if (!found) throw new Error(`turn ${id} not seeded`);
  return found;
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
  resetTutorialState();
  ensureLocalStorage().clear();
  delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
});

describe("useFirstRunConductor", () => {
  it("drives the LOCAL path end to end: greeting → runtime → provider → tutorial → completeFirstRun, POSTing exactly once", async () => {
    const spies = seedAppStore();
    const { turn, unmount } = renderConductor();

    // Mount seeds the greeting with the runtime CHOICE.
    const greeting = await waitForTurn(turn, "first-run:greeting");
    expect(greeting.text).toContain("where should your agent run?");
    expect(greeting.text).toContain("__first_run__:runtime:local=");
    expect(greeting.source).toBe("first_run");

    // Runtime pick → provider CHOICE with on-device pre-highlighted first.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    const provider = await waitForTurn(turn, "first-run:provider");
    expect(provider.text).toContain("__first_run__:provider:on-device=");
    expect(provider.text.indexOf("provider:on-device")).toBeLessThan(
      provider.text.indexOf("provider:other"),
    );

    // Provider pick runs the REAL finish: local runtime boot (no-op off
    // desktop/mobile), POST /api/first-run, background model download, then
    // the deferred tutorial CHOICE.
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    const tutorial = await waitForTurn(turn, "first-run:tutorial");
    expect(tutorial.text).toContain("__first_run__:tutorial:start=");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).toHaveBeenCalledTimes(1);
    // The real store flip is DEFERRED to the tutorial pick.
    expect(spies.completeFirstRun).not.toHaveBeenCalled();

    // After provisioning, re-taps on leftover widgets are consumed as no-ops:
    // nothing re-runs and POST /api/first-run stays at exactly once.
    const authCallsAfterFinish = mocks.client.getAuthStatus.mock.calls.length;
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mocks.client.getAuthStatus.mock.calls.length).toBe(
      authCallsAfterFinish,
    );
    expect(turn("first-run:cloud-oauth")).toBeUndefined();
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);

    // Tutorial skip: the SINGLE real completion; no tour is launched.
    expect(tryHandleFirstRunAction("__first_run__:tutorial:skip")).toBe(true);
    expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    expect(readTutorialState().active).toBe(false);

    unmount();
  });

  it("keeps BYOK reachable after the runtime chooser was trimmed to Cloud + On this device: On this device → provider:other routes to the Settings handoff banner without a model download", async () => {
    const spies = seedAppStore();
    const { turn, unmount } = renderConductor();
    const greeting = await waitForTurn(turn, "first-run:greeting");

    // The clean chooser offers exactly two locations — no "Bring your own keys"
    // (runtime:other) button; BYOK is the provider sub-choice one step later.
    expect(greeting.text).toContain("__first_run__:runtime:cloud=");
    expect(greeting.text).toContain("__first_run__:runtime:local=");
    expect(greeting.text).not.toContain("runtime:other");

    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    const provider = await waitForTurn(turn, "first-run:provider");
    // The provider sub-choice still offers "Other / configure in Settings" (BYOK).
    expect(provider.text).toContain("__first_run__:provider:other=");

    expect(tryHandleFirstRunAction("__first_run__:provider:other")).toBe(true);
    await waitForTurn(turn, "first-run:tutorial");

    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    // configure-later wires NO provider: the Settings banner surfaces and no
    // on-device model download starts.
    expect(spies.showActionBanner).toHaveBeenCalledTimes(1);
    expect(spies.showActionBanner.mock.calls[0][0].text).toContain(
      "model provider in Settings",
    );
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).not.toHaveBeenCalled();
    unmount();
  });

  it("the runtime chooser offers exactly two locations and consumes a stale runtime:other pick as a no-op", async () => {
    seedAppStore();
    const { turn, transcript, unmount } = renderConductor();
    const greeting = await waitForTurn(turn, "first-run:greeting");
    const runtimeButtons = (
      greeting.text.match(/__first_run__:runtime:/g) ?? []
    ).length;
    expect(runtimeButtons).toBe(2);

    // A leftover/stale runtime:other action (e.g. an old transcript widget) is
    // still consumed by the handler but seeds no provider turn.
    expect(tryHandleFirstRunAction("__first_run__:runtime:other")).toBe(true);
    expect(transcript.current.some((m) => m.id === "first-run:provider")).toBe(
      false,
    );
    unmount();
  });

  it("drives the CLOUD path: OAuth turn → agent CHOICE → bind → tutorial start launches the tour", async () => {
    mocks.client.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        {
          agent_id: "agent-1",
          agent_name: "Prod",
          status: "running",
          created_at: "2026-01-02T00:00:00.000Z",
        },
        {
          agent_id: "agent-2",
          agent_name: "Scratch",
          status: "stopped",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ] as never[],
    });
    const spies = seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    // The OAuth secretRequest turn seeds immediately (pending), then flips to
    // saved once the agent list resolves.
    const oauthPending = await waitForTurn(turn, "first-run:cloud-oauth");
    expect(oauthPending.secretRequest?.form?.kind).toBe("oauth");
    await waitFor(() => {
      expect(turn("first-run:cloud-oauth")?.secretRequest?.status).toBe(
        "saved",
      );
    });

    // ≥1 agents → a cloud-agent CHOICE (running agent first, plus create-new).
    const agentChoice = await waitForTurn(turn, "first-run:cloud-agent");
    expect(agentChoice.text).toContain(
      "__first_run__:cloud-agent:agent-1=Prod",
    );
    expect(agentChoice.text).toContain(
      "__first_run__:cloud-agent:new=Create a new agent",
    );

    expect(tryHandleFirstRunAction("__first_run__:cloud-agent:agent-1")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).toMatchObject({ preferAgentId: "agent-1", authToken: "cloud-token" });
    // The bound base owns app-shell routes → first-run persisted exactly once.
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);

    // "Take the tutorial" completes AND launches the interactive tour.
    expect(tryHandleFirstRunAction("__first_run__:tutorial:start")).toBe(true);
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    expect(readTutorialState().active).toBe(true);
    unmount();
  });

  it("surfaces a cloud listing failure as an error turn with the runtime CHOICE again, then a LOCAL retry succeeds", async () => {
    mocks.client.getCloudCompatAgents.mockRejectedValue(
      new Error("cloud is down"),
    );
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some(
          (message) =>
            message.id.startsWith("first-run:error:") &&
            // A transport failure surfaces a friendly, actionable line — never
            // the raw thrown message (e.g. "Unable to resolve host …").
            message.text.includes("Couldn't reach Eliza Cloud") &&
            !message.text.includes("cloud is down"),
        ),
      ).toBe(true);
    });
    const errorTurn = transcript.current.find((message) =>
      message.id.startsWith("first-run:error:"),
    );
    // The error turn re-offers the runtime CHOICE so the flow is recoverable.
    expect(errorTurn?.text).toContain("__first_run__:runtime:local=");
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();

    // Retry via LOCAL still reaches the tutorial (and the single POST).
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("consumes every pick while a provisioning flow is in flight — no concurrent flows", async () => {
    let releaseAgents: (value: { success: true; data: never[] }) => void =
      () => {};
    mocks.client.getCloudCompatAgents.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAgents = resolve as typeof releaseAgents;
        }),
    );
    seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitForTurn(turn, "first-run:cloud-oauth");
    // A confused user spams other options while the agent listing is still in
    // flight: a duplicate cloud tap, a local tap, and a provider tap. All are
    // consumed as no-ops — no provider turn, no second flow, no POST.
    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mocks.client.getCloudCompatAgents).toHaveBeenCalledTimes(1);
    expect(turn("first-run:provider")).toBeUndefined();
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();

    // The in-flight flow settles normally: 0 agents → auto-provision → tutorial.
    releaseAgents({ success: true, data: [] });
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("consumes malformed values under the reserved prefix without acting on them", async () => {
    const spies = seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    const turnsBefore = transcript.current.length;

    for (const value of [
      "__first_run__:",
      "__first_run__:runtime",
      "__first_run__:runtime:",
      "__first_run__:runtime:bogus",
      "__first_run__:provider:on-device; DROP TABLE users",
      "__first_run__:tutorial:yes",
      "__first_run__:cloud-agent:",
      "__first_run__:backup-restore:oops",
      "__first_run__:☃:❄",
      "__first_run__:unknown-group:value",
    ]) {
      expect(tryHandleFirstRunAction(value)).toBe(true);
    }
    // A non-first-run value is NOT consumed by the channel.
    expect(tryHandleFirstRunAction("hello")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(transcript.current.length).toBe(turnsBefore);
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();
    expect(mocks.client.getCloudCompatAgents).not.toHaveBeenCalled();
    expect(mocks.client.selectOrProvisionCloudAgent).not.toHaveBeenCalled();
    expect(spies.completeFirstRun).not.toHaveBeenCalled();
    unmount();
  });

  it("latches the tutorial pick: a double-tap completes exactly once and never launches a second tour", async () => {
    const spies = seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");

    expect(tryHandleFirstRunAction("__first_run__:tutorial:skip")).toBe(true);
    expect(tryHandleFirstRunAction("__first_run__:tutorial:skip")).toBe(true);
    expect(tryHandleFirstRunAction("__first_run__:tutorial:start")).toBe(true);
    expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    // The late "start" tap after the skip must not launch the tour.
    expect(readTutorialState().active).toBe(false);
    unmount();
  });

  it("re-offers an UNLOCKED runtime choice when cloud login does not land, and the LOCAL escape completes", async () => {
    delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
    mocks.client.getCloudStatus.mockResolvedValue({ connected: false });
    seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitFor(() => {
      expect(turn("first-run:cloud-oauth")?.secretRequest?.status).toBe(
        "failed",
      );
    });
    // No dead end: the retry turn carries a fresh (unlocked) runtime CHOICE.
    expect(turn("first-run:cloud-oauth")?.text).toContain(
      "__first_run__:runtime:local=",
    );

    // The user bails to LOCAL and still completes onboarding.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("auto-resumes the interrupted cloud flow when the cloud connection lands", async () => {
    delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
    mocks.client.getCloudStatus.mockResolvedValue({ connected: false });
    seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitFor(() => {
      expect(turn("first-run:cloud-oauth")?.secretRequest?.status).toBe(
        "failed",
      );
    });
    expect(mocks.client.selectOrProvisionCloudAgent).not.toHaveBeenCalled();

    // The user connects from the OAuth block instead of re-picking: the token
    // lands and the store learns the connection — the flow resumes by itself.
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
      "cloud-token";
    mocks.client.getCloudStatus.mockResolvedValue({ connected: true });
    seedAppStore({ elizaCloudConnected: true });

    await waitForTurn(turn, "first-run:tutorial");
    expect(turn("first-run:cloud-oauth")?.secretRequest?.status).toBe("saved");
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("re-offers a FRESH provider turn on a runtime re-pick after a failed finish (locked-widget dead end)", async () => {
    // First POST /api/first-run fails, second succeeds.
    mocks.client.submitFirstRun.mockRejectedValueOnce(
      new Error("first-run write failed"),
    );
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitFor(() => {
      expect(
        transcript.current.some((message) =>
          message.id.startsWith("first-run:error:"),
        ),
      ).toBe(true);
    });

    // The user re-picks LOCAL from the error turn. The original provider turn
    // still exists (its widget locked itself on the first pick), so the
    // conductor must seed a FRESH provider turn — otherwise the retry is a
    // dead end in the real UI.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some((message) =>
          message.id.startsWith("first-run:provider:retry:"),
        ),
      ).toBe(true);
    });

    // The retried provider pick completes: second POST succeeds → tutorial.
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("unregisters the action handler on unmount so identical values no longer short-circuit", async () => {
    seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    unmount();
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(false);
  });

  it("is a complete no-op once firstRunComplete is true (the chat-overlay shell mounts it unconditionally)", async () => {
    // The chat-overlay branch (desktop bottom bar AND any plain web
    // ?shellMode=chat-overlay load) mounts the conductor UNGATED — this pins
    // the hook's own gate so that mount adds no onboarding turns, no backup
    // probe, and no first-run action interception after onboarding.
    seedAppStore({ firstRunComplete: true });
    const { transcript, unmount } = renderConductor();

    // Flush effects + any stray microtasks: nothing may be seeded.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transcript.current).toEqual([]);
    expect(mocks.client.listLocalAgentBackups).not.toHaveBeenCalled();
    // No handler registered → the chat send funnel is NOT intercepted.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(false);
    unmount();
  });
});

// ── surfaceCloudLoginRetryTurn (pure transcript seam) ────────────────────────

function applyRetry(existing: ConversationMessage[]): ConversationMessage[] {
  let messages = [...existing];
  surfaceCloudLoginRetryTurn({
    seedTurn(turn) {
      messages = messages.some((message) => message.id === turn.id)
        ? messages
        : [...messages, turn];
    },
    replaceTurn(id, next) {
      messages = messages.map((message) =>
        message.id === id ? next : message,
      );
    },
  });
  return messages;
}

describe("surfaceCloudLoginRetryTurn", () => {
  it("adds the cloud OAuth retry turn when the hybrid path never seeded one", () => {
    const messages = applyRetry([
      {
        id: "first-run:provider",
        role: "assistant",
        text: "Which model provider should Eliza use?",
        timestamp: 1,
        source: "first_run",
      },
    ]);

    expect(messages.map((message) => message.id)).toEqual([
      "first-run:provider",
      "first-run:cloud-oauth",
    ]);
    expect(messages[1]?.secretRequest?.status).toBe("failed");
    expect(messages[1]?.secretRequest?.form?.kind).toBe("oauth");
    expect(messages[1]?.text).toContain("Connect your Eliza Cloud account");
  });

  it("replaces the existing cloud OAuth turn on the managed-cloud path", () => {
    const messages = applyRetry([
      {
        id: "first-run:cloud-oauth",
        role: "assistant",
        text: "Connecting your Eliza Cloud account...",
        timestamp: 1,
        source: "first_run",
        secretRequest: {
          key: "elizacloud",
          reason: "Connect your Eliza Cloud account",
          status: "pending",
          form: {
            type: "sensitive_request_form",
            kind: "oauth",
            mode: "cloud_authenticated_link",
            fields: [],
            submitLabel: "Connect Eliza Cloud",
            provider: "elizacloud",
            authorizationUrl: "https://example.test",
          },
        },
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("first-run:cloud-oauth");
    expect(messages[0]?.secretRequest?.status).toBe("failed");
    // The retry turn re-offers an UNLOCKED runtime CHOICE — without it, every
    // earlier runtime widget is locked and "pick again" is a dead end.
    expect(messages[0]?.text).toContain("pick how to run your agent again");
    expect(messages[0]?.text).toContain("__first_run__:runtime:local=");
    expect(messages[0]?.text).toContain("__first_run__:runtime:cloud=");
  });
});

// ── persistFirstRun exactly-once under concurrency (via the real finish) ────

function makeFinishPorts(): FirstRunFinishPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    handleCloudLogin: async () => undefined,
    setRuntimeState: () => {},
    showActionBanner: () => {},
    setTab: () => {},
    completeFirstRun: () => {},
  };
}

describe("persistFirstRun (driven through runFirstRunFinish)", () => {
  it("shares one in-flight POST between concurrently double-fired finishes", async () => {
    resetFirstRunPersistGuard();
    let resolveSubmit: () => void = () => {};
    mocks.client.submitFirstRun.mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSubmit = () => resolve(undefined);
        }),
    );
    try {
      const draft: FirstRunFinishDraft = {
        agentName: "Eliza",
        runtime: "local",
        localInference: "all-local",
        remoteApiBase: "",
        remoteToken: "",
      };
      const ports = makeFinishPorts();
      // Two finishes race (the pre-guard conductor could double-fire this);
      // both must share ONE POST /api/first-run.
      const first = runFirstRunFinish(draft, ports);
      const second = runFirstRunFinish(draft, ports);
      await waitFor(() => {
        expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
      });
      resolveSubmit();
      const outcomes = await Promise.all([first, second]);
      expect(outcomes.map((outcome) => outcome.kind)).toEqual(["done", "done"]);
      expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    } finally {
      mocks.client.submitFirstRun.mockImplementation(async () => undefined);
    }
  });

  it("releases the in-flight guard on failure so a retry can POST again", async () => {
    resetFirstRunPersistGuard();
    mocks.client.submitFirstRun.mockRejectedValueOnce(
      new Error("network down"),
    );
    const draft: FirstRunFinishDraft = {
      agentName: "Eliza",
      runtime: "local",
      localInference: "all-local",
      remoteApiBase: "",
      remoteToken: "",
    };
    const ports = makeFinishPorts();
    const failed = await runFirstRunFinish(draft, ports);
    expect(failed.kind).toBe("error");

    const retried = await runFirstRunFinish(draft, ports);
    expect(retried.kind).toBe("done");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(2);
  });
});
