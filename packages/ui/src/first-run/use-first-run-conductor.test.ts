// @vitest-environment jsdom

/**
 * The in-chat first-run conductor, driven through its REAL public seams: the
 * hook is mounted (registering its handler on the first-run action channel),
 * picks arrive via `tryHandleFirstRunAction` exactly as the chat send funnel
 * delivers them, and the REAL finish use case (`first-run-finish.ts`) runs
 * underneath. Mocks sit only at the network boundary (the shared `client`
 * singleton + the background model download).
 */

import { renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    listLocalAgentBackups: vi.fn(
      async (): Promise<LocalAgentBackupMetadata[]> => [],
    ),
    restoreLocalAgentBackup: vi.fn(async () => undefined),
    getAuthStatus: vi.fn(async () => ({ required: false })),
    getCloudStatus: vi.fn(async () => ({ connected: true })),
    getCloudCompatAgents: vi.fn(
      async (): Promise<{
        success: boolean;
        data: unknown[];
        error?: string;
      }> => ({
        success: true,
        data: [],
      }),
    ),
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
  // The same-origin Steward cookie refresh (POST w/ credentials) — a network
  // boundary like the client, mocked so the silent cookie-recovery entry
  // (#15133) is drivable without a real .elizacloud.ai session.
  refreshCloudStewardSession: vi.fn(
    async (): Promise<{ token?: string } | null> => null,
  ),
  preOpenCloudLoginWindow: vi.fn((): Window | null => null),
  // The device RAM probe is a native boundary like the client: tests inject a
  // tier here (null = jsdom's honest "unknown"); the gate's own probe path is
  // covered in device-ram-gate.test.ts against the real bridge seam.
  deviceRamTier: null as
    | import("./device-ram-tier").DeviceRamTierAssessment
    | null,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, client: mocks.client };
});

vi.mock("../api/client-cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client-cloud")>();
  return {
    ...actual,
    refreshCloudStewardSession: mocks.refreshCloudStewardSession,
  };
});

vi.mock("./auto-download-recommended", () => ({
  autoDownloadRecommendedLocalModelInBackground:
    mocks.autoDownloadRecommendedLocalModelInBackground,
}));

vi.mock("./device-ram-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-ram-gate")>();
  return {
    ...actual,
    peekDeviceRamTierAssessment: () => mocks.deviceRamTier,
    resolveDeviceRamTierAssessment: async () =>
      mocks.deviceRamTier ?? actual.peekDeviceRamTierAssessment(),
    // Mirrors the real backstop contract against the injected tier so the
    // finish path enforces the same policy the conductor gates on.
    assertDeviceRamTierAllowsLocalRuntime: async (localInference: string) => {
      const tier = mocks.deviceRamTier;
      if (!tier) return;
      if (!tier.allowsLocalAgent) {
        throw new Error(
          `This device can't run the on-device agent: ${tier.reason}.`,
        );
      }
      if (localInference === "all-local" && !tier.allowsLocalModels) {
        throw new Error(
          `This device can't run on-device models: ${tier.reason}.`,
        );
      }
    },
  };
});

vi.mock("../state/cloud-login-launch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../state/cloud-login-launch")>();
  return {
    ...actual,
    preOpenCloudLoginWindow: mocks.preOpenCloudLoginWindow,
  };
});

import type { ConversationMessage, LocalAgentBackupMetadata } from "../api";
import { __setAppValueForTests } from "../state/app-store";
import {
  ConversationMessagesCtx,
  type ConversationMessagesValue,
} from "../state/ConversationMessagesContext.hooks";
import type { AppContextValue } from "../state/internal";
import { classifyDeviceRamTier } from "./device-ram-tier";
import {
  tryHandleFirstRunAction,
  tryHandleFirstRunText,
} from "./first-run-action-channel";
import {
  clearCloudLoginPending,
  markCloudLoginPending,
  readCloudLoginPending,
} from "./first-run-cloud-resume";
import {
  type FirstRunFinishDraft,
  type FirstRunFinishPorts,
  resetFirstRunPersistGuard,
  runFirstRunFinish,
} from "./first-run-finish";
import { MOBILE_RUNTIME_MODE_STORAGE_KEY } from "./mobile-runtime-mode";
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
  setTab: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

/** Seed the app-store slice the conductor selects; everything else is inert. */
function seedAppStore(overrides: Record<string, unknown> = {}): AppStoreSpies {
  const spies: AppStoreSpies = {
    completeFirstRun: vi.fn(),
    handleCloudLogin: vi.fn(async () => undefined),
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
    prependConversationMessages: () => {},
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
  mocks.deviceRamTier = null;
  mocks.client.listLocalAgentBackups.mockResolvedValue([]);
  // `clearAllMocks` resets call history but NOT implementations, so restore the
  // default resolved implementations that individual tests override (a leaked
  // `mockRejectedValue`/`mockResolvedValue` would otherwise poison later tests).
  mocks.client.submitFirstRun.mockResolvedValue(undefined);
  mocks.client.selectOrProvisionCloudAgent.mockResolvedValue({
    apiBase: "https://agent.example.test",
    agentId: "agent-1",
    created: false,
  });
  mocks.client.getCloudCompatAgents.mockResolvedValue({
    success: true,
    data: [],
  });
  mocks.client.getCloudStatus.mockResolvedValue({ connected: true });
  mocks.refreshCloudStewardSession.mockResolvedValue(null);
  mocks.preOpenCloudLoginWindow.mockReturnValue(null);
  localStorage.setItem("steward_session_token", "cloud-token");
  // The runtime chooser (local / remote paths) is OFF by default (#13377);
  // these suites exercise the full chooser, so they opt in via the override.
  // The cloud-only describe block below removes it per-test.
  localStorage.setItem("eliza:enable-runtime-chooser", "1");
});

afterEach(() => {
  __setAppValueForTests(null);
  resetTutorialState();
  ensureLocalStorage().clear();
  // Drop the steward-authed marker cookie some cloud-only tests plant — a
  // leaked cookie would flip later mounts into the silent recovery branch.
  writeTestCookie("steward-authed=; expires=Thu, 01 Jan 1970 00:00:00 GMT");
});

function writeTestCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom tests drive the same browser cookie marker production reads.
  document.cookie = value;
}

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

  it("seeds a skippable accent step at wrap-up: picking a swatch applies + persists the accent live, garbage picks no-op, and it never gates completion", async () => {
    const setUiAccent = vi.fn();
    const spies = seedAppStore({ setUiAccent });
    const { turn, unmount } = renderConductor();

    await waitForTurn(turn, "first-run:greeting");
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );

    // Wrap-up seeds BOTH the accent step and the tutorial prompt, so accent is
    // optional — the tutorial CHOICE is already present to finish.
    const appearance = await waitForTurn(turn, "first-run:appearance");
    await waitForTurn(turn, "first-run:tutorial");
    expect(appearance.text).toContain("make it yours");
    expect(appearance.text).toContain("__first_run__:accent:default=");
    expect(appearance.text).toContain("__first_run__:accent:green=");
    expect(appearance.source).toBe("first_run");

    // Picking a swatch applies + persists via the shared store setter; it does
    // NOT complete first-run (that stays deferred to the tutorial pick).
    expect(tryHandleFirstRunAction("__first_run__:accent:green")).toBe(true);
    expect(setUiAccent).toHaveBeenCalledTimes(1);
    expect(setUiAccent).toHaveBeenCalledWith("green");
    expect(spies.completeFirstRun).not.toHaveBeenCalled();

    // A garbage accent id under the reserved prefix is consumed as a no-op.
    expect(tryHandleFirstRunAction("__first_run__:accent:bogus")).toBe(true);
    expect(setUiAccent).toHaveBeenCalledTimes(1);

    // The tutorial pick is still the single real completion — accent skippable.
    expect(tryHandleFirstRunAction("__first_run__:tutorial:skip")).toBe(true);
    expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");

    unmount();
  });

  it("keeps BYOK reachable after the runtime chooser was trimmed to Cloud + On this device: On this device → provider:other finishes the LOCAL runtime with configure-later (one POST, no model download, Settings handoff banner) instead of dead-ending to Settings", async () => {
    const spies = seedAppStore();
    const { turn, transcript, unmount } = renderConductor();
    const greeting = await waitForTurn(turn, "first-run:greeting");

    // The chooser offers three locations — Cloud, On this device, Remote — but
    // NOT "Bring your own keys" (runtime:other); BYOK is the provider sub-choice
    // one step later.
    expect(greeting.text).toContain("__first_run__:runtime:cloud=");
    expect(greeting.text).toContain("__first_run__:runtime:local=");
    expect(greeting.text).toContain("__first_run__:runtime:remote=");
    expect(greeting.text).not.toContain("runtime:other");

    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    const provider = await waitForTurn(turn, "first-run:provider");
    // The provider sub-choice still offers "Other / configure in Settings" (BYOK).
    expect(provider.text).toContain("__first_run__:provider:other=");

    // Selecting it finishes the LOCAL runtime with `configure-later`: the finish
    // path starts + persists the runtime (one POST /api/first-run) and hands off
    // provider setup to Settings via the "Open Settings" action banner. It does
    // NOT dead-end to Settings before persisting — the old exit-to-Settings path
    // never ran a finish, so a broken finish had no recovery turn.
    expect(tryHandleFirstRunAction("__first_run__:provider:other")).toBe(true);
    const tutorial = await waitForTurn(turn, "first-run:tutorial");
    expect(tutorial.text).toContain("__first_run__:tutorial:start=");

    // Exactly one POST, and NO model download (configure-later ships no model —
    // the user brings their own provider keys in Settings).
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).not.toHaveBeenCalled();
    // No floating banner fires — the transcript's no-provider gate is the
    // Settings handoff surface — and the real completion stays deferred to the
    // tutorial pick.
    expect(spies.completeFirstRun).not.toHaveBeenCalled();

    // After provisioning, re-taps on the leftover provider widget are consumed
    // as no-ops — no second finish, POST stays at exactly once.
    expect(tryHandleFirstRunAction("__first_run__:provider:other")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);

    // The tutorial pick is the single real completion, into chat.
    expect(tryHandleFirstRunAction("__first_run__:tutorial:skip")).toBe(true);
    expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    expect(transcript.current.some((m) => m.id === "first-run:greeting")).toBe(
      true,
    );
    unmount();
  });

  it("the runtime chooser offers exactly three locations and consumes a stale runtime:other pick as a no-op", async () => {
    seedAppStore();
    const { turn, transcript, unmount } = renderConductor();
    const greeting = await waitForTurn(turn, "first-run:greeting");
    const runtimeButtons = (
      greeting.text.match(/__first_run__:runtime:/g) ?? []
    ).length;
    expect(runtimeButtons).toBe(3);

    // A leftover/stale runtime:other action (e.g. an old transcript widget) is
    // still consumed by the handler but seeds no provider turn.
    expect(tryHandleFirstRunAction("__first_run__:runtime:other")).toBe(true);
    expect(transcript.current.some((m) => m.id === "first-run:provider")).toBe(
      false,
    );
    unmount();
  });

  it("seeds the greeting IMMEDIATELY even when the local-backup probe never settles (cold-start unblock)", async () => {
    // The regression: a fresh/booting device whose agent API hangs left the
    // greeting unseeded (it used to be gated inside the backups probe's
    // continuations), stranding the user at a locked composer. The greeting
    // must now appear regardless of the probe.
    mocks.client.listLocalAgentBackups.mockReturnValue(
      new Promise<never>(() => {}), // never resolves and never rejects
    );
    seedAppStore();
    const { turn, transcript, unmount } = renderConductor();

    const greeting = await waitForTurn(turn, "first-run:greeting");
    expect(greeting.text).toContain("where should your agent run?");
    // And the runtime pick still works while the probe is stuck.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    // No backup-restore turn was seeded (the probe never returned any).
    expect(
      transcript.current.some((m) => m.id === "first-run:backup-restore"),
    ).toBe(false);
    unmount();
  });

  it("appends the backup-restore choice below the greeting when backups exist — but not once the user advanced past it", async () => {
    // Backups resolve AFTER the greeting is already up: restore is offered as
    // an additional turn, never replacing the greeting.
    const backup = {
      fileName: "backup-1.tar",
      path: "/backups/backup-1.tar",
      createdAt: "2026-07-01T00:00:00.000Z",
      agentId: "agent-1",
      stateSha256: "sha-1",
      sizeBytes: 10,
    };
    mocks.client.listLocalAgentBackups.mockResolvedValue([backup]);
    seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    const restore = await waitForTurn(turn, "first-run:backup-restore");
    expect(restore.text).toContain("__first_run__:backup-restore:");
    unmount();

    // Now the racing case: if the user picks a runtime BEFORE the (slow) backup
    // probe resolves, the restore turn must NOT be appended after the fact.
    vi.clearAllMocks();
    let resolveBackups: (b: LocalAgentBackupMetadata[]) => void = () => {};
    mocks.client.listLocalAgentBackups.mockReturnValue(
      new Promise<LocalAgentBackupMetadata[]>((resolve) => {
        resolveBackups = resolve;
      }),
    );
    seedAppStore();
    const second = renderConductor();
    await waitForTurn(second.turn, "first-run:greeting");
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(second.turn, "first-run:provider");
    // Backups arrive late — the user already advanced, so no restore turn.
    resolveBackups([backup]);
    await Promise.resolve();
    expect(
      second.transcript.current.some(
        (m) => m.id === "first-run:backup-restore",
      ),
    ).toBe(false);
    second.unmount();
  });

  it("REMOTE pick seeds the inline URL+token connect form (no provider step, no immediate finish)", async () => {
    seedAppStore();
    const { turn, transcript, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:remote")).toBe(true);
    const connect = await waitForTurn(turn, "first-run:remote-connect");

    // A remote_connect secret form with a URL field + optional token field.
    expect(connect.secretRequest?.form?.kind).toBe("remote_connect");
    const fieldNames = (connect.secretRequest?.form?.fields ?? []).map(
      (f) => f.name,
    );
    expect(fieldNames).toEqual(["url", "token"]);
    expect(
      connect.secretRequest?.delivery?.canCollectValueInCurrentChannel,
    ).toBe(true);

    // Remote owns its provider: no provider sub-step, and onboarding is NOT
    // finished yet (the user must submit the form → CONNECT_EVENT completes it).
    expect(transcript.current.some((m) => m.id === "first-run:provider")).toBe(
      false,
    );
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();
    unmount();
  });

  it("drives the CLOUD path: OAuth turn → direct bind → tutorial start launches the tour", async () => {
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
    // saved once the cloud agent bind resolves. The first-run Cloud request is
    // status-only so onboarding has one sign-in action, not a second OAuth
    // button inside the status block.
    const oauthPending = await waitForTurn(turn, "first-run:cloud-oauth");
    expect(oauthPending.secretRequest?.form).toBeUndefined();
    await waitFor(() => {
      expect(turn("first-run:cloud-oauth")?.secretRequest?.status).toBe(
        "saved",
      );
    });
    expect(turn("first-run:cloud-oauth")?.secretRequest?.reason).toBe(
      "Eliza Cloud connected",
    );

    await waitForTurn(turn, "first-run:tutorial");
    expect(turn("first-run:cloud-agent")).toBeUndefined();
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).toMatchObject({ authToken: "cloud-token" });
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).not.toHaveProperty("preferAgentId");
    // The bound base owns app-shell routes → first-run persisted exactly once.
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);

    // "Take the tutorial" completes AND launches the interactive tour.
    expect(tryHandleFirstRunAction("__first_run__:tutorial:start")).toBe(true);
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    expect(readTutorialState().active).toBe(true);
    unmount();
  });

  it("arms a durable cloud-login resume marker synchronously when the cloud runtime is picked", async () => {
    // The marker must be persisted at pick time — BEFORE the external browser
    // login can background/evict the WebView — so an eviction mid-login can
    // resume on relaunch instead of restarting at the greeting. Assert it
    // synchronously, before the async provision completes and clears it.
    seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    expect(readCloudLoginPending()).toBeNull();

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    expect(readCloudLoginPending()).toMatchObject({
      runtime: "cloud",
      localInference: "cloud-inference",
    });
    unmount();
  });

  it("pre-opens the Cloud auth window synchronously and reuses it for login", async () => {
    const authWindow = { close: vi.fn() } as unknown as Window;
    mocks.preOpenCloudLoginWindow.mockReturnValue(authWindow);
    mocks.client.getCloudStatus.mockResolvedValue({ connected: false });
    const spies = seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);

    expect(mocks.preOpenCloudLoginWindow).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(spies.handleCloudLogin).toHaveBeenCalledWith(authWindow);
    });
    unmount();
  });

  it("resumes an interrupted cloud login on relaunch (no greeting restart) when the durable marker + connection are present", async () => {
    // Simulate the device flow AFTER the eviction+relaunch: the resume marker
    // was persisted before the external browser login evicted the WebView, and
    // the durable steward token makes elizaCloudConnected recompute true at
    // mount. The conductor must CONTINUE into chat, not re-seed the "where
    // should your agent run?" greeting.
    markCloudLoginPending({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });
    const spies = seedAppStore(); // elizaCloudConnected: true (durable token)
    const { transcript, turn, unmount } = renderConductor();

    // It resumes straight into provisioning and completes onboarding into chat…
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    // …and NEVER bounced the user back to the runtime chooser.
    expect(transcript.current.some((m) => m.id === "first-run:greeting")).toBe(
      false,
    );
    // Completion clears the durable marker so a later launch starts clean.
    expect(readCloudLoginPending()).toBeNull();

    // "Take the tutorial" completes onboarding into chat.
    expect(tryHandleFirstRunAction("__first_run__:tutorial:start")).toBe(true);
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    unmount();
  });

  it("clears the cloud resume marker on a fresh local runtime pick so a relaunch never resumes an abandoned cloud flow", async () => {
    // The user had armed a cloud marker, then came back and chose local. Local
    // is the latest intent — the stale cloud marker must be cleared.
    markCloudLoginPending({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });
    // A local marker does not resume (readCloudLoginPending rejects non-cloud),
    // so the greeting seeds normally and we can drive a fresh local pick.
    clearCloudLoginPending();
    seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    // Re-arm as if a prior cloud attempt left the marker behind.
    markCloudLoginPending({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    expect(readCloudLoginPending()).toBeNull();
    unmount();
  });

  it("surfaces a cloud provisioning lookup failure as a DISTINCT recovery turn (retry / restart / Settings), and 'restart' → LOCAL succeeds", async () => {
    mocks.client.selectOrProvisionCloudAgent.mockRejectedValueOnce(
      new Error(
        "Couldn't reach Eliza Cloud to find your agents. Check your connection and try again.",
      ),
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
    // The error turn is a DISTINCT recovery surface — it does NOT silently
    // re-offer the runtime question (the infinite-loop bug). It offers retry,
    // restart, and an explicit Settings escape.
    expect(errorTurn?.text).not.toContain("__first_run__:runtime:local=");
    expect(errorTurn?.text).toContain("__first_run__:error:retry=");
    expect(errorTurn?.text).toContain("__first_run__:error:restart=");
    expect(errorTurn?.text).toContain("__first_run__:error:settings=");
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();

    // "Choose a different way to run" re-offers a fresh runtime choice; picking
    // LOCAL from it still reaches the tutorial (and the single POST).
    expect(tryHandleFirstRunAction("__first_run__:error:restart")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some((m) =>
          m.id.startsWith("first-run:greeting:retry:"),
        ),
      ).toBe(true);
    });
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a persistent finish 404 does NOT re-loop the runtime question: the error turn stays distinct, offers retry, and 'Configure in Settings' escapes", async () => {
    // Simulate the reported bug: POST /api/first-run always 404s ("Not found").
    mocks.client.submitFirstRun.mockRejectedValue(new Error("Not found"));
    const spies = seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    // Local → on-device → finish 404s → a distinct error turn (NOT the greeting,
    // NOT a bare runtime prompt).
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    const firstError = await waitFor(() => {
      const t = transcript.current.find((m) =>
        m.id.startsWith("first-run:error:"),
      );
      expect(t).toBeTruthy();
      return t as ConversationMessage;
    });
    // Human message, not the raw "Not found"; distinct from the greeting; no
    // re-looped runtime question.
    expect(firstError.text).toContain("couldn't finish setting up your agent");
    expect(firstError.text).not.toBe(turn("first-run:greeting")?.text);
    expect(firstError.text).not.toContain("__first_run__:runtime:local=");

    // Retry hits the SAME 404 — but each failure produces ONE bounded error
    // turn, never an unbounded storm of runtime prompts.
    const errorCountAfterFirst = transcript.current.filter((m) =>
      m.id.startsWith("first-run:error:"),
    ).length;
    expect(errorCountAfterFirst).toBe(1);
    expect(tryHandleFirstRunAction("__first_run__:error:retry")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.filter((m) => m.id.startsWith("first-run:error:"))
          .length,
      ).toBe(2);
    });
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(2);

    // The guaranteed escape: "Configure in Settings" opens Settings and exits
    // first-run even though finish never succeeded.
    expect(tryHandleFirstRunAction("__first_run__:error:settings")).toBe(true);
    expect(spies.setTab).toHaveBeenCalledWith("settings");
    expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    expect(spies.completeFirstRun).toHaveBeenCalledWith("settings");
    unmount();
  });

  it("error:retry after a CLOUD lookup failure re-seeds the OAuth turn and re-runs cloud provisioning", async () => {
    mocks.client.selectOrProvisionCloudAgent.mockRejectedValueOnce(
      new Error(
        "Couldn't reach Eliza Cloud to find your agents. Check your connection and try again.",
      ),
    );
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some((m) => m.id.startsWith("first-run:error:")),
      ).toBe(true);
    });

    // "Try again" re-runs the SAME (cloud) flow: it re-seeds the connecting
    // OAuth turn and calls the shared selector again.
    expect(tryHandleFirstRunAction("__first_run__:error:retry")).toBe(true);
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(2);
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    expect(turn("first-run:cloud-oauth")?.secretRequest?.status).toBe("saved");
    unmount();
  });

  it("consumes every pick while a provisioning flow is in flight — no concurrent flows", async () => {
    let releaseAgent: (value: {
      apiBase: string;
      agentId: string;
      created: boolean;
    }) => void = () => {};
    mocks.client.selectOrProvisionCloudAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseAgent = resolve as typeof releaseAgent;
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
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(turn("first-run:provider")).toBeUndefined();
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();

    // The in-flight flow settles normally: shared selector → tutorial.
    releaseAgent({
      apiBase: "https://agent.example.test",
      agentId: "agent-1",
      created: false,
    });
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

  it("closes the claimed Cloud login popup after first-run auth succeeds", async () => {
    localStorage.removeItem("steward_session_token");
    const close = vi.fn();
    const popup = { close } as unknown as Window;
    mocks.preOpenCloudLoginWindow.mockReturnValue(popup);
    mocks.client.getCloudStatus
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValue({ connected: true });
    const handleCloudLogin = vi.fn(async () => {
      localStorage.setItem("steward_session_token", "cloud-token");
    });
    seedAppStore({
      elizaCloudConnected: false,
      handleCloudLogin,
    });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitFor(() => {
      expect(handleCloudLogin).toHaveBeenCalledWith(popup);
    });
    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    expect(turn("first-run:cloud-oauth")?.secretRequest?.form).toBeUndefined();

    unmount();
  });

  it("re-offers an UNLOCKED runtime choice when cloud login does not land, and the LOCAL escape completes", async () => {
    localStorage.removeItem("steward_session_token");
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
    localStorage.removeItem("steward_session_token");
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
    localStorage.setItem("steward_session_token", "cloud-token");
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

    // The user takes "Choose a different way to run" from the error turn, then
    // re-picks LOCAL. The original provider turn still exists (its widget locked
    // itself on the first pick), so the conductor must seed a FRESH provider
    // turn — otherwise the retry is a dead end in the real UI.
    expect(tryHandleFirstRunAction("__first_run__:error:restart")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some((message) =>
          message.id.startsWith("first-run:greeting:retry:"),
        ),
      ).toBe(true);
    });
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

// ── completion edge purges the synthetic onboarding transcript (#15354) ───────

/**
 * Mount the conductor with a preseedable, ref-backed transcript AND the ability
 * to flip `firstRunComplete` between renders — so the onboarding-complete edge
 * (`active` → false) is drivable exactly as the store flip drives it live.
 */
function renderConductorWithControls(initialFirstRunComplete: boolean) {
  const transcript: { current: ConversationMessage[] } = { current: [] };
  const value: ConversationMessagesValue = {
    conversationMessages: [],
    removeConversationMessage: () => {},
    prependConversationMessages: () => {},
    setConversationMessages: (updater) => {
      transcript.current =
        typeof updater === "function" ? updater(transcript.current) : updater;
    },
  };
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(ConversationMessagesCtx.Provider, { value }, children);
  seedAppStore({ firstRunComplete: initialFirstRunComplete });
  const utils = renderHook(() => useFirstRunConductor(), { wrapper });
  const setFirstRunComplete = (complete: boolean) => {
    seedAppStore({ firstRunComplete: complete });
    utils.rerender();
  };
  return { transcript, setFirstRunComplete, ...utils };
}

describe("first-run completion clears the synthetic onboarding transcript", () => {
  it("drops leftover first-run turns on the complete edge so one send is not shown as many (#15354)", async () => {
    const { transcript, setFirstRunComplete, unmount } =
      renderConductorWithControls(false);
    // Let the mount effect register + seed its greeting (active onboarding).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Reproduce the #15354 store shape at the moment onboarding completes: the
    // conductor-seeded first-run turns (greeting + welcome-back + cloud-done)
    // are still in the live transcript, and the user's one real optimistic send
    // has been appended by the chat send path.
    transcript.current = [
      {
        id: "first-run:greeting",
        role: "assistant",
        text: "Sign in to Eliza Cloud",
        timestamp: 1,
        source: "first_run",
      },
      {
        id: "first-run:cloud-signin",
        role: "assistant",
        text: "Welcome back",
        timestamp: 2,
        source: "first_run",
      },
      {
        id: "first-run:cloud-done",
        role: "assistant",
        text: "All set",
        timestamp: 3,
        source: "first_run",
      },
      { id: "temp-1000", role: "user", text: "hi", timestamp: 4 },
      { id: "temp-resp-1000", role: "assistant", text: "hey!", timestamp: 5 },
    ];

    // The store flips firstRunComplete → true (onboarding done). The conductor's
    // completion effect must purge the synthetic turns.
    setFirstRunComplete(true);
    await waitFor(() => {
      expect(
        transcript.current.some((m) => m.id.startsWith("first-run:")),
      ).toBe(false);
    });

    // Exactly the single real turn survives: ONE user message + ONE response.
    expect(transcript.current.map((m) => m.id)).toEqual([
      "temp-1000",
      "temp-resp-1000",
    ]);
    expect(transcript.current.filter((m) => m.role === "user")).toHaveLength(1);
    expect(
      transcript.current.filter((m) => m.role === "assistant"),
    ).toHaveLength(1);
    unmount();
  });

  it("leaves a real, already-clean thread untouched on completion (no spurious mutation)", async () => {
    const { transcript, setFirstRunComplete, unmount } =
      renderConductorWithControls(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    transcript.current = [
      { id: "srv-user-1", role: "user", text: "hi", timestamp: 4 },
      { id: "srv-asst-1", role: "assistant", text: "hey!", timestamp: 5 },
    ];

    setFirstRunComplete(true);
    // Flush the completion effect.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(transcript.current.map((m) => m.id)).toEqual([
      "srv-user-1",
      "srv-asst-1",
    ]);
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
    expect(messages[1]?.secretRequest?.form).toBeUndefined();
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

  it("cloud-only mode (chooser off) re-offers only the sign-in button — no runtime chooser", () => {
    localStorage.removeItem("eliza:enable-runtime-chooser");
    const messages = applyRetry([]);

    expect(messages[0]?.id).toBe("first-run:cloud-oauth");
    expect(messages[0]?.secretRequest?.status).toBe("failed");
    expect(messages[0]?.text).toContain("Sign in to Eliza Cloud to continue");
    expect(messages[0]?.text).toContain("__first_run__:runtime:cloud=");
    expect(messages[0]?.text).not.toContain("__first_run__:runtime:local=");
    expect(messages[0]?.text).not.toContain("__first_run__:runtime:remote=");
  });
});

// ── Cloud-only onboarding (#13377): the runtime chooser is OFF by default ────

describe("cloud-only onboarding (runtime chooser off — the production default)", () => {
  beforeEach(() => {
    localStorage.removeItem("eliza:enable-runtime-chooser");
  });

  it("seeds the single sign-in greeting — no local/remote options, no backup probe, no unprompted provisioning", async () => {
    localStorage.removeItem("steward_session_token");
    seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();

    const greeting = await waitForTurn(turn, "first-run:greeting");
    expect(greeting.text).toContain("Sign in to Eliza Cloud");
    expect(greeting.text).toContain("__first_run__:runtime:cloud=");
    expect(greeting.text).not.toContain("__first_run__:runtime:local=");
    expect(greeting.text).not.toContain("__first_run__:runtime:remote=");
    expect(greeting.source).toBe("first_run");
    // Restoring a local agent backup is a chooser-mode concept.
    expect(mocks.client.listLocalAgentBackups).not.toHaveBeenCalled();
    // Nothing provisions (and no login window can open) without a session or
    // a sign-in tap.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mocks.client.getCloudCompatAgents).not.toHaveBeenCalled();
    unmount();
  });

  it("silent entry (#15133): a usable stored session + one agent seeds ZERO onboarding turns — no greeting, no welcome-back, no reuse narration, no done wrap-up", async () => {
    // steward_session_token is present via the outer beforeEach; the account
    // already owns one running agent, so this is a pure reuse.
    mocks.client.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        {
          agent_id: "agent-only",
          agent_name: "Only",
          status: "running",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    const spies = seedAppStore({ elizaCloudConnected: true });
    const { transcript, unmount } = renderConductor();

    await waitFor(() => {
      expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    });
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    // The #15133 bar: an authenticated user's next rendered state is the
    // agent chat itself — the transcript carries NOT ONE onboarding turn.
    expect(transcript.current).toEqual([]);
    // The shared selector adopts the best healthy agent directly (no picker).
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).toMatchObject({ authToken: "cloud-token" });
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).not.toHaveProperty("preferAgentId");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("sign-in tap drives the cloud flow to real completion once the session lands", async () => {
    localStorage.removeItem("steward_session_token");
    const spies = seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    // The tap is the user gesture that launches the login flow; the session
    // (stored token) lands during it.
    localStorage.setItem("steward_session_token", "cloud-token");
    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitForTurn(turn, "first-run:cloud-oauth");
    await waitFor(() => {
      expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    });
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    await waitForTurn(turn, "first-run:cloud-done");
    expect(turn("first-run:tutorial")).toBeUndefined();
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a session landing WITHOUT a tap auto-continues (login from another same-origin tab / injected hosted session)", async () => {
    localStorage.removeItem("steward_session_token");
    mocks.client.getCloudStatus.mockResolvedValue({ connected: false });
    seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    expect(mocks.client.selectOrProvisionCloudAgent).not.toHaveBeenCalled();

    localStorage.setItem("steward_session_token", "cloud-token");
    mocks.client.getCloudStatus.mockResolvedValue({ connected: true });
    const spies = seedAppStore({ elizaCloudConnected: true });

    await waitFor(() => {
      expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    });
    await waitForTurn(turn, "first-run:cloud-done");
    expect(mocks.client.selectOrProvisionCloudAgent).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a connected cloud-only session binds directly without surfacing the agent selector", async () => {
    mocks.client.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        {
          agent_id: "agent-newest-running",
          agent_name: "Newest",
          status: "running",
          created_at: "2026-01-02T00:00:00.000Z",
        },
        {
          agent_id: "agent-older",
          agent_name: "Older",
          status: "stopped",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const spies = seedAppStore({ elizaCloudConnected: true });
    const { transcript, turn, unmount } = renderConductor();

    await waitFor(() => {
      expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    });
    expect(transcript.current.some((m) => m.id === "first-run:greeting")).toBe(
      false,
    );
    expect(turn("first-run:cloud-agent")).toBeUndefined();
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).toMatchObject({ authToken: "cloud-token" });
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).not.toHaveProperty("preferAgentId");
    unmount();
  });

  it("zero agents stay silent through the reuse lookup and narrate ONLY the real provisioning (#15133)", async () => {
    // No stored agents; selectOrProvisionCloudAgent emits the REAL client's
    // progress sequence for a create: the reuse lookup ("listing"), the actual
    // create ("creating"), then ready.
    mocks.client.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [],
    });
    mocks.client.selectOrProvisionCloudAgent.mockImplementation(
      async (options: Record<string, unknown>) => {
        const onProgress = options.onProgress as (
          status: string,
          detail?: string,
        ) => void;
        onProgress("listing", "Finding your agents...");
        onProgress("creating", "Creating Eliza...");
        onProgress("ready", "Cloud agent ready!");
        return {
          apiBase: "https://agent.example.test",
          agentId: "agent-new",
          created: true,
        };
      },
    );
    const spies = seedAppStore({ elizaCloudConnected: true });
    const { transcript, turn, unmount } = renderConductor();

    await waitFor(() => {
      expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    });
    // Bookkeeping narration stays silent…
    expect(turn("first-run:greeting")).toBeUndefined();
    expect(turn("first-run:cloud-signin")).toBeUndefined();
    expect(
      turn("first-run:status:Setting up your cloud agent"),
    ).toBeUndefined();
    expect(turn("first-run:status:Finding your agents...")).toBeUndefined();
    // …but the REAL create is a genuine wait, so it narrates honestly from
    // its first "creating" code onward (including the done wrap-up).
    await waitForTurn(turn, "first-run:status:Creating Eliza...");
    await waitForTurn(turn, "first-run:status:Cloud agent ready!");
    await waitForTurn(turn, "first-run:cloud-done");
    expect(
      transcript.current.every(
        (m) =>
          m.id.startsWith("first-run:status:") ||
          m.id === "first-run:cloud-done",
      ),
    ).toBe(true);
    unmount();
  });

  it("cross-subdomain cookie at mount (#15133): recovers the session BEFORE seeding anything — zero onboarding turns, straight into the single agent", async () => {
    // First visit to the app subdomain after signing in on the console: no
    // app-origin localStorage, but the non-HttpOnly steward-authed marker is
    // present and the bounded refresh returns a token.
    localStorage.removeItem("steward_session_token");
    writeTestCookie("steward-authed=1");
    mocks.refreshCloudStewardSession.mockResolvedValue({
      token: "cookie-token",
    });
    mocks.client.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        {
          agent_id: "agent-console",
          agent_name: "Console",
          status: "running",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    const spies = seedAppStore({ elizaCloudConnected: false });
    const { transcript, unmount } = renderConductor();

    await waitFor(() => {
      expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
    });
    expect(spies.completeFirstRun).toHaveBeenCalledWith("chat");
    // The recovered token was persisted for the app origin…
    expect(mocks.refreshCloudStewardSession).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("steward_session_token")).toBe("cookie-token");
    // …and the user saw NOTHING: no greeting flash, no welcome-back, no
    // provisioning theater — the next rendered state is the agent chat.
    expect(transcript.current).toEqual([]);
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).toMatchObject({
      authToken: "cookie-token",
    });
    expect(
      mocks.client.selectOrProvisionCloudAgent.mock.calls[0][0],
    ).not.toHaveProperty("preferAgentId");
    unmount();
  });

  it("a stale marker cookie degrades to today's sign-in greeting after the bounded refresh fails — then the token poll still upgrades to welcome-back", async () => {
    localStorage.removeItem("steward_session_token");
    writeTestCookie("steward-authed=1");
    mocks.refreshCloudStewardSession.mockResolvedValue(null);
    mocks.client.getCloudStatus.mockResolvedValue({ connected: false });
    const spies = seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();

    // The failed recovery falls back to EXACTLY the unauthenticated flow: the
    // normal sign-in greeting, no fabricated session, nothing provisioned.
    const greeting = await waitForTurn(turn, "first-run:greeting");
    expect(greeting.text).toContain("Sign in to Eliza Cloud");
    expect(spies.completeFirstRun).not.toHaveBeenCalled();
    expect(mocks.client.getCloudCompatAgents).not.toHaveBeenCalled();

    // The degrade also armed the 500ms token poll, so a session landing later
    // (login in another tab) still upgrades — with the welcome-back turn,
    // because a greeting was genuinely shown on this path.
    localStorage.setItem("steward_session_token", "cloud-token");
    mocks.client.getCloudStatus.mockResolvedValue({ connected: true });
    await waitFor(
      () => {
        expect(turn("first-run:cloud-signin")).toBeTruthy();
      },
      { timeout: 3_000 },
    );
    await waitFor(
      () => {
        expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 },
    );
    unmount();
  });

  it("the silent cookie hold answers free text with the provisioning persona, and an unmount mid-refresh seeds nothing", async () => {
    localStorage.removeItem("steward_session_token");
    writeTestCookie("steward-authed=1");
    let resolveRefresh: (value: { token: string } | null) => void = () => {};
    mocks.refreshCloudStewardSession.mockImplementation(
      () =>
        new Promise<{ token: string } | null>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    seedAppStore({ elizaCloudConnected: false });
    const { transcript, turn, unmount } = renderConductor();

    // During the bounded hold nothing is seeded — the shell shows the empty
    // first-run chat. Typing gets the "hang tight" persona (there is no
    // sign-in ask on screen for the signIn nudge to point at).
    expect(transcript.current).toEqual([]);
    expect(tryHandleFirstRunText("hello?")).toBe(true);
    const reply = await waitForTurn(turn, "first-run:reply:1");
    expect(reply.text).toContain("Hang tight");

    // The effect-cleanup cancelled flag: a refresh settling after unmount
    // must not seed the greeting into a dead transcript (or resume anything).
    const turnsAtUnmount = transcript.current.length;
    unmount();
    resolveRefresh(null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transcript.current.length).toBe(turnsAtUnmount);
    expect(mocks.client.getCloudCompatAgents).not.toHaveBeenCalled();
  });

  it("a token hydrating AFTER mount (native storage restore) auto-continues without a tap", async () => {
    localStorage.removeItem("steward_session_token");
    mocks.client.getCloudStatus.mockResolvedValue({ connected: false });
    const spies = seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    expect(mocks.client.selectOrProvisionCloudAgent).not.toHaveBeenCalled();

    // The storage bridge restores the durable token asynchronously on native;
    // the conductor's 500ms poll must pick it up and skip the sign-in tap.
    localStorage.setItem("steward_session_token", "cloud-token");
    await waitFor(
      () => {
        expect(turn("first-run:cloud-signin")).toBeTruthy();
      },
      { timeout: 3_000 },
    );
    await waitFor(
      () => {
        expect(spies.completeFirstRun).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 },
    );
    await waitForTurn(turn, "first-run:cloud-done");
    unmount();
  });

  it("needs-cloud-login re-offers the sign-in button only — never the runtime chooser", async () => {
    localStorage.removeItem("steward_session_token");
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
    const retry = turn("first-run:cloud-oauth");
    expect(retry?.text).toContain("Sign in to Eliza Cloud to continue");
    expect(retry?.text).toContain("__first_run__:runtime:cloud=");
    expect(retry?.text).not.toContain("__first_run__:runtime:local=");
    unmount();
  });

  it("finish errors offer retry + Settings only — 'choose a different way to run' does not exist", async () => {
    mocks.client.selectOrProvisionCloudAgent.mockRejectedValue(
      new Error("cloud agent lookup failed"),
    );
    const spies = seedAppStore({ elizaCloudConnected: true });
    const { transcript, unmount } = renderConductor();

    // The silent entry seeds no welcome-back turn; the failure surfaces as
    // the error recovery turn directly (errors always render, silent or not).
    await waitFor(() => {
      expect(
        transcript.current.some((message) =>
          message.id.startsWith("first-run:error:"),
        ),
      ).toBe(true);
    });
    const error = transcript.current.find((message) =>
      message.id.startsWith("first-run:error:"),
    );
    expect(error?.text).toContain("__first_run__:error:retry=");
    expect(error?.text).toContain("__first_run__:error:settings=");
    expect(error?.text).not.toContain("__first_run__:error:restart=");
    expect(error?.text).not.toContain("different way to run");
    expect(spies.completeFirstRun).not.toHaveBeenCalled();
    unmount();
  });

  it("stale local/remote/provider picks are consumed without starting a flow", async () => {
    localStorage.removeItem("steward_session_token");
    seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    expect(tryHandleFirstRunAction("__first_run__:runtime:remote")).toBe(true);
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    expect(tryHandleFirstRunAction("__first_run__:backup-restore:latest")).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(turn("first-run:provider")).toBeUndefined();
    expect(turn("first-run:remote-connect")).toBeUndefined();
    expect(mocks.client.getAuthStatus).not.toHaveBeenCalled();
    unmount();
  });

  it("answers free text with the sign-in nudge while no session exists", async () => {
    localStorage.removeItem("steward_session_token");
    seedAppStore({ elizaCloudConnected: false });
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunText("hello?")).toBe(true);
    const userTurn = await waitForTurn(turn, "first-run:user:1");
    expect(userTurn.text).toBe("hello?");
    const reply = await waitForTurn(turn, "first-run:reply:1");
    expect(reply.text).toContain("sign in to Eliza Cloud");
    unmount();
  });

  it("a stale cloud session (connected in memory, no usable token) does not complete onboarding or loop provisioning (#14387)", async () => {
    // elizaCloudConnected reads true, but the durable steward token is gone, so
    // getCloudAuthToken() is empty and the bind reports needs-cloud-login. Pre-fix
    // this re-armed the auto-resume marker WHILE already "connected", and the
    // effect re-fired on every seeded-turn render → an unbounded
    // provision→fail→re-arm loop that spammed the transcript. The fix skips the
    // re-arm while connected and fires the auto-resume effect at most once per
    // connection epoch, so the stale session lands on a bounded recovery surface
    // and never silently completes onboarding.
    localStorage.removeItem("steward_session_token");
    mocks.client.getCloudCompatAgents.mockResolvedValue({
      success: true,
      data: [
        {
          agent_id: "agent-stale",
          agent_name: "Stale",
          status: "running",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const spies = seedAppStore({ elizaCloudConnected: true });
    const { transcript, unmount } = renderConductor();

    // A recovery surface (sign-in retry OR error card) appears — onboarding is
    // NOT silently completed on a stale/invalid token.
    await waitFor(() => {
      expect(
        transcript.current.some(
          (m) =>
            m.id === "first-run:cloud-oauth" ||
            m.id.startsWith("first-run:error:"),
        ),
      ).toBe(true);
    });
    expect(spies.completeFirstRun).not.toHaveBeenCalled();

    // No runaway: give any residual auto-resume loop a window, then prove the
    // provisioning was attempted a bounded number of times and does not keep
    // growing (pre-fix it grew every re-fired render).
    const attempts = mocks.client.selectOrProvisionCloudAgent.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mocks.client.selectOrProvisionCloudAgent.mock.calls.length).toBe(
      attempts,
    );
    expect(attempts).toBeLessThanOrEqual(3);
    unmount();
  });
});

// ── persistFirstRun exactly-once under concurrency (via the real finish) ────

function makeFinishPorts(): FirstRunFinishPorts {
  return {
    uiLanguage: "en",
    elizaCloudConnected: true,
    handleCloudLogin: async () => undefined,
    setRuntimeState: () => {},
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

describe("useFirstRunConductor — free-text replies (#12178 composer unlock)", () => {
  it("echoes typed text as a local user turn + a friendly not-ready reply, never touching the server", async () => {
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    // Before any runtime is picked, typing is answered with the "choosing"
    // persona. The conductor renders the user's text as a real user turn.
    expect(tryHandleFirstRunText("will this work yet?")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some(
          (m) => m.role === "user" && m.text === "will this work yet?",
        ),
      ).toBe(true);
    });
    const reply = transcript.current.find(
      (m) => m.role === "assistant" && m.id.startsWith("first-run:reply:"),
    );
    expect(reply?.text).toContain("pick one of the options above");
    // The hard rule: no first-run POST happened just from typing.
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();
    unmount();
  });

  it("varies the reply by flow position: wrap-up copy once provisioning is done", async () => {
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    // Drive the LOCAL path to completion so the wrap-up (tutorial) step is live.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");

    expect(tryHandleFirstRunText("what now?")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some(
          (m) =>
            m.role === "assistant" &&
            m.id.startsWith("first-run:reply:") &&
            m.text.includes("Almost there"),
        ),
      ).toBe(true);
    });
    unmount();
  });

  it("consumes blank text as a no-op (no empty turn, no reply)", async () => {
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");
    const before = transcript.current.length;
    expect(tryHandleFirstRunText("   ")).toBe(true);
    expect(transcript.current.length).toBe(before);
    unmount();
  });
});

describe("device RAM-tier gating + reversible onboarding (#14390)", () => {
  it("labels the local option unavailable on a sub-8 GB device and refuses the pick with the reason", async () => {
    mocks.deviceRamTier = classifyDeviceRamTier(4);
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();

    // The greeting's local option is visibly gated — never silently hidden.
    const greeting = await waitForTurn(turn, "first-run:greeting");
    expect(greeting.text).toContain("__first_run__:runtime:local=");
    expect(greeting.text).toContain("unavailable — needs 8 GB+ RAM");
    expect(greeting.text).toContain("~4 GB detected");

    // The tap is refused at the decision point: a refusal turn with the
    // reason and a FRESH runtime choice — no provider step, no finish.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some((m) =>
          m.id.startsWith("first-run:runtime-blocked:"),
        ),
      ).toBe(true);
    });
    const blocked = transcript.current.find((m) =>
      m.id.startsWith("first-run:runtime-blocked:"),
    );
    expect(blocked?.text).toContain("~4 GB RAM");
    expect(blocked?.text).toContain("[CHOICE:first-run id=runtime]");
    expect(turn("first-run:provider")).toBeUndefined();
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();

    // Cloud remains a live way forward from the re-offered choice.
    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitForTurn(turn, "first-run:cloud-oauth");
    unmount();
  });

  it("blocks on-device models on a sub-12 GB device but finishes the hybrid local runtime", async () => {
    mocks.deviceRamTier = classifyDeviceRamTier(8);
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    // The local AGENT is allowed on this band; only on-device models gate.
    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    const provider = await waitForTurn(turn, "first-run:provider");
    expect(provider.text).toContain("unavailable — needs 12 GB+ RAM");
    expect(provider.text).toContain(
      "__first_run__:provider:elizacloud=Eliza Cloud inference (recommended)",
    );
    expect(provider.text).toContain("__first_run__:back:runtime=");

    // The blocked on-device pick is refused with a fresh provider choice.
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitFor(() => {
      expect(
        transcript.current.some((m) =>
          m.id.startsWith("first-run:provider:retry:"),
        ),
      ).toBe(true);
    });
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).not.toHaveBeenCalled();

    // Eliza Cloud inference (hybrid) is the allowed local path here and
    // completes the REAL finish: exactly one POST, no model download, and the
    // hybrid runtime mode persisted.
    expect(tryHandleFirstRunAction("__first_run__:provider:elizacloud")).toBe(
      true,
    );
    await waitForTurn(turn, "first-run:tutorial");
    expect(mocks.client.submitFirstRun).toHaveBeenCalledTimes(1);
    expect(
      mocks.autoDownloadRecommendedLocalModelInBackground,
    ).not.toHaveBeenCalled();
    expect(localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "cloud-hybrid",
    );
    unmount();
  });

  it("annotates (but allows) on-device models on the 12-15 GB warn band", async () => {
    mocks.deviceRamTier = classifyDeviceRamTier(12);
    seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    const provider = await waitForTurn(turn, "first-run:provider");
    expect(provider.text).toContain("Heads up:");
    expect(provider.text).toContain("can be slow and run warm");
    expect(provider.text).toContain(
      "__first_run__:provider:on-device=On this device (recommended)",
    );
    unmount();
  });

  it("goes back from the provider step to a fresh, unlocked runtime choice", async () => {
    seedAppStore();
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    const provider = await waitForTurn(turn, "first-run:provider");
    expect(provider.text).toContain("__first_run__:back:runtime=");

    expect(tryHandleFirstRunAction("__first_run__:back:runtime")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some((m) =>
          m.id.startsWith("first-run:greeting:retry:"),
        ),
      ).toBe(true);
    });
    const reoffer = transcript.current.find((m) =>
      m.id.startsWith("first-run:greeting:retry:"),
    );
    expect(reoffer?.text).toContain("__first_run__:runtime:cloud=");
    // Nothing was committed or POSTed by the abandoned local path.
    expect(mocks.client.submitFirstRun).not.toHaveBeenCalled();
    expect(localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBeNull();

    // The re-offered choice is live: cloud proceeds normally.
    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitForTurn(turn, "first-run:cloud-oauth");
    unmount();
  });

  it("offers a back affordance under the remote connect form", async () => {
    seedAppStore();
    const { turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:remote")).toBe(true);
    const connect = await waitForTurn(turn, "first-run:remote-connect");
    expect(connect.secretRequest?.form?.kind).toBe("remote_connect");
    expect(connect.text).toContain("__first_run__:back:runtime=");
    unmount();
  });

  it("unwinds a partially-committed local finish when the user switches to cloud (restart)", async () => {
    seedAppStore();
    // The local finish gets as far as persisting the runtime mode + active
    // server, then its POST fails — the exact partial-commitment shape the
    // reversal must clean up.
    mocks.client.submitFirstRun.mockRejectedValueOnce(
      new Error("first-run persist failed"),
    );
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    expect(tryHandleFirstRunAction("__first_run__:runtime:local")).toBe(true);
    await waitForTurn(turn, "first-run:provider");
    expect(tryHandleFirstRunAction("__first_run__:provider:on-device")).toBe(
      true,
    );
    await waitFor(() => {
      expect(
        transcript.current.some((m) => m.id.startsWith("first-run:error:")),
      ).toBe(true);
    });
    // The failed local path left real committed state behind.
    expect(localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe("local");
    expect(localStorage.getItem("elizaos:active-server")).toContain("local:");

    // "Choose a different way to run" reverts the commitment before
    // re-offering, so switching to cloud leaves nothing local behind.
    expect(tryHandleFirstRunAction("__first_run__:error:restart")).toBe(true);
    await waitFor(() => {
      expect(
        transcript.current.some((m) =>
          m.id.startsWith("first-run:greeting:retry:"),
        ),
      ).toBe(true);
    });
    expect(localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("elizaos:active-server")).toBeNull();

    expect(tryHandleFirstRunAction("__first_run__:runtime:cloud")).toBe(true);
    await waitForTurn(turn, "first-run:cloud-oauth");
    unmount();
  });

  it("consumes back picks as stale no-ops in cloud-only mode", async () => {
    localStorage.removeItem("eliza:enable-runtime-chooser");
    localStorage.removeItem("steward_session_token");
    seedAppStore({ elizaCloudConnected: false });
    const { transcript, turn, unmount } = renderConductor();
    await waitForTurn(turn, "first-run:greeting");

    const before = transcript.current.length;
    expect(tryHandleFirstRunAction("__first_run__:back:runtime")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // No re-offered runtime chooser exists in cloud-only mode.
    expect(
      transcript.current.some((m) =>
        m.id.startsWith("first-run:greeting:retry:"),
      ),
    ).toBe(false);
    expect(transcript.current.length).toBe(before);
    unmount();
  });
});
