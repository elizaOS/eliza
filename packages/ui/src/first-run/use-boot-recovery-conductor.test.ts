// @vitest-environment jsdom

/**
 * The in-chat boot-recovery conductor, driven through its real seams: the hook
 * is mounted with booting/noProviderConfigured/handoff inputs, seeds ONE
 * `boot:recovery` turn into the transcript once a boot stalls past the
 * threshold, and its `__boot_recovery__:` controls arrive via
 * `tryHandleBootRecoveryAction` exactly as the chat send funnel delivers them.
 * Mocks sit only at the app-store selector and the steward-session probe.
 */

import { renderHook } from "@testing-library/react";
import * as React from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {
    firstRunComplete: true as boolean | null,
    handleCloudLogin: vi.fn(async () => {}),
    triggerRestart: vi.fn(async () => {}),
    backendConnection: {
      state: "connected" as
        | "connected"
        | "disconnected"
        | "reconnecting"
        | "failed",
      reconnectAttempt: 0,
      maxReconnectAttempts: 15,
      showDisconnectedUI: false,
    },
    retryBackendConnection: vi.fn(),
  },
  hasUsableStoredStewardToken: vi.fn(() => true),
  dispatchCloudHandoffRetry: vi.fn(),
  openCloudBillingConsole: vi.fn(async () => {}),
}));

vi.mock("../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state")>();
  return {
    ...actual,
    useAppSelectorShallow: <T>(selector: (s: unknown) => T): T =>
      selector(mocks.store),
  };
});

vi.mock("../state/cloud-steward-login", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../state/cloud-steward-login")>();
  return {
    ...actual,
    hasUsableStoredStewardToken: () => mocks.hasUsableStoredStewardToken(),
  };
});

vi.mock("../events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../events")>();
  return {
    ...actual,
    dispatchCloudHandoffRetry: (detail: { agentId: string }) =>
      mocks.dispatchCloudHandoffRetry(detail),
  };
});

vi.mock("../cloud/billing-console", () => ({
  openCloudBillingConsole: () => mocks.openCloudBillingConsole(),
}));

import type { ConversationMessage } from "../api";
import type { CloudHandoffPhaseDetail } from "../events";
import {
  ConversationMessagesCtx,
  type ConversationMessagesValue,
} from "../state/ConversationMessagesContext.hooks";
import { tryHandleBootRecoveryAction } from "./boot-recovery-channel";
import {
  BOOT_STALL_AFTER_MS,
  useBootRecoveryConductor,
} from "./use-boot-recovery-conductor";

interface ConductorInputs {
  booting: boolean;
  noProviderConfigured: boolean;
  handoff: CloudHandoffPhaseDetail | null;
}

function renderConductor(initial: ConductorInputs) {
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
  const utils = renderHook(
    (p: ConductorInputs) =>
      useBootRecoveryConductor(p.booting, p.noProviderConfigured, p.handoff),
    { wrapper, initialProps: initial },
  );
  const card = (): ConversationMessage | undefined =>
    transcript.current.find((m) => m.id === "boot:recovery");
  return { transcript, card, ...utils };
}

const BOOTING: ConductorInputs = {
  booting: true,
  noProviderConfigured: false,
  handoff: null,
};

function stall() {
  act(() => {
    vi.advanceTimersByTime(BOOT_STALL_AFTER_MS + 1);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.store.firstRunComplete = true;
  mocks.store.backendConnection = {
    state: "connected",
    reconnectAttempt: 0,
    maxReconnectAttempts: 15,
    showDisconnectedUI: false,
  };
  mocks.hasUsableStoredStewardToken.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBootRecoveryConductor", () => {
  it("stays silent through a normal boot and only speaks after the stall threshold", () => {
    const { card, unmount } = renderConductor(BOOTING);
    act(() => {
      vi.advanceTimersByTime(BOOT_STALL_AFTER_MS - 1_000);
    });
    expect(card()).toBeUndefined();
    stall();
    expect(card()).toBeTruthy();
    expect(card()?.text).toContain("hard time waking up");
    expect(card()?.source).toBe("boot_recovery");
    unmount();
  });

  it("offers Try again first when the cloud session is usable", () => {
    const { card, unmount } = renderConductor(BOOTING);
    stall();
    const text = card()?.text ?? "";
    expect(text).toContain("isn't responding");
    expect(text.indexOf("__boot_recovery__:retry=")).toBeGreaterThan(-1);
    expect(text.indexOf("__boot_recovery__:retry=")).toBeLessThan(
      text.indexOf("__boot_recovery__:relogin="),
    );
    unmount();
  });

  it("diagnoses a signed-out session and leads with Re-log in", () => {
    mocks.hasUsableStoredStewardToken.mockReturnValue(false);
    const { card, unmount } = renderConductor(BOOTING);
    stall();
    const text = card()?.text ?? "";
    expect(text).toContain("signed out");
    expect(text.indexOf("__boot_recovery__:relogin=")).toBeLessThan(
      text.indexOf("__boot_recovery__:retry="),
    );
    unmount();
  });

  it("removes the card the moment the boot recovers", () => {
    const { card, rerender, unmount } = renderConductor(BOOTING);
    stall();
    expect(card()).toBeTruthy();
    rerender({ ...BOOTING, booting: false });
    expect(card()).toBeUndefined();
    unmount();
  });

  it("never seeds during onboarding (the first-run conductor owns that screen)", () => {
    mocks.store.firstRunComplete = false;
    const { card, unmount } = renderConductor(BOOTING);
    stall();
    expect(card()).toBeUndefined();
    unmount();
  });

  it("never seeds in the no-provider state (the transcript no-provider gate owns it)", () => {
    const { card, unmount } = renderConductor({
      ...BOOTING,
      noProviderConfigured: true,
    });
    stall();
    expect(card()).toBeUndefined();
    unmount();
  });

  it("surfaces a failed dedicated-agent handoff with a Retry setup control and opens the chat once", () => {
    const opens: number[] = [];
    const onOpen = () => opens.push(1);
    window.addEventListener("eliza:chat:open", onOpen);
    const { card, rerender, unmount } = renderConductor({
      booting: false,
      noProviderConfigured: false,
      handoff: { phase: "failed", agentId: "agent-1" },
    });
    expect(card()?.text).toContain("dedicated agent");
    expect(card()?.text).toContain("__boot_recovery__:retry-handoff=");
    // The resting overlay shows no transcript — the first seed opens the chat
    // so the ask is seen; a same-episode update must not re-open it.
    expect(opens.length).toBe(1);
    rerender({
      booting: false,
      noProviderConfigured: false,
      handoff: { phase: "timed-out", agentId: "agent-1" },
    });
    expect(opens.length).toBe(1);
    window.removeEventListener("eliza:chat:open", onOpen);
    unmount();
  });

  it("still surfaces a failed handoff when no provider is configured (the exclusion scopes to the stall diagnosis)", () => {
    const { card, unmount } = renderConductor({
      booting: false,
      noProviderConfigured: true,
      handoff: { phase: "failed", agentId: "agent-2" },
    });
    expect(card()?.text).toContain("dedicated agent");
    unmount();
  });

  it("surfaces the 402 credit gate as a first-class add-credits card, not a generic failure", () => {
    const { card, unmount } = renderConductor({
      booting: false,
      noProviderConfigured: false,
      handoff: { phase: "insufficient-credits", agentId: "agent-402" },
    });
    const text = card()?.text ?? "";
    // Nubs's 0-credit guidance: explicit "on free shared agent + add credits",
    // not a silent connect failure and not the generic setup-failed copy.
    expect(text).toContain("free shared agent");
    expect(text).toContain("Add credits");
    expect(text).toContain("__boot_recovery__:add-credits=");
    expect(text).toContain("__boot_recovery__:retry-handoff=");
    expect(text).not.toContain("couldn't finish setting up");
    unmount();
  });

  it("add-credits opens the billing console without healing the trouble (user stays on shared)", () => {
    const { card, unmount } = renderConductor({
      booting: false,
      noProviderConfigured: false,
      handoff: { phase: "insufficient-credits", agentId: "agent-402" },
    });
    act(() => {
      expect(tryHandleBootRecoveryAction("__boot_recovery__:add-credits")).toBe(
        true,
      );
    });
    expect(mocks.openCloudBillingConsole).toHaveBeenCalledTimes(1);
    // The card stays put (with its controls) so the user can retry after funding.
    expect(card()?.text).toContain("__boot_recovery__:add-credits=");
    unmount();
  });

  it("retry-handoff also re-dispatches the upgrade for the insufficient-credits trouble", () => {
    const { unmount } = renderConductor({
      booting: false,
      noProviderConfigured: false,
      handoff: { phase: "insufficient-credits", agentId: "agent-402b" },
    });
    act(() => {
      expect(
        tryHandleBootRecoveryAction("__boot_recovery__:retry-handoff"),
      ).toBe(true);
    });
    expect(mocks.dispatchCloudHandoffRetry).toHaveBeenCalledWith({
      agentId: "agent-402b",
    });
    unmount();
  });

  it("retry-handoff re-dispatches the handoff supervisor for the tracked agent", async () => {
    const { card, unmount } = renderConductor({
      booting: false,
      noProviderConfigured: false,
      handoff: { phase: "timed-out", agentId: "agent-9" },
    });
    expect(card()).toBeTruthy();
    act(() => {
      expect(
        tryHandleBootRecoveryAction("__boot_recovery__:retry-handoff"),
      ).toBe(true);
    });
    expect(mocks.dispatchCloudHandoffRetry).toHaveBeenCalledWith({
      agentId: "agent-9",
    });
    expect(card()?.text).toContain("Retrying your dedicated agent setup");
    act(() => {
      vi.advanceTimersByTime(1_501);
    });
    expect(card()?.text).toContain("__boot_recovery__:retry-handoff=");
    unmount();
  });

  it("relogin drives the cloud login and returns the live controls after it settles", async () => {
    mocks.hasUsableStoredStewardToken.mockReturnValue(false);
    const { card, unmount } = renderConductor(BOOTING);
    stall();
    act(() => {
      expect(tryHandleBootRecoveryAction("__boot_recovery__:relogin")).toBe(
        true,
      );
    });
    expect(card()?.text).toContain("Opening Eliza Cloud sign-in");
    expect(mocks.store.handleCloudLogin).toHaveBeenCalledTimes(1);
    // The login flow settles without the boot healing (still stalled): the
    // live card with its controls must return — never a dead-end card.
    // (Flush the settled promise chain inside act; waitFor would deadlock
    // under fake timers.)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(card()?.text).toContain("__boot_recovery__:relogin=");
    unmount();
  });

  it("retry drives triggerRestart and surfaces a failure as an error card with controls", async () => {
    mocks.store.triggerRestart.mockRejectedValueOnce(new Error("api down"));
    const { card, unmount } = renderConductor(BOOTING);
    stall();
    act(() => {
      expect(tryHandleBootRecoveryAction("__boot_recovery__:retry")).toBe(true);
    });
    expect(card()?.text).toContain("Reconnecting");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(card()?.text).toContain("Couldn't reconnect");
    expect(card()?.text).toContain("api down");
    expect(card()?.text).toContain("__boot_recovery__:retry=");
    unmount();
  });

  it("a failed backend connection outranks every other trouble and offers Reconnect", () => {
    mocks.store.backendConnection = {
      state: "failed",
      reconnectAttempt: 15,
      maxReconnectAttempts: 15,
      showDisconnectedUI: false,
    };
    const { card, unmount } = renderConductor({
      booting: true,
      noProviderConfigured: false,
      handoff: { phase: "failed", agentId: "agent-1" },
    });
    stall();
    const text = card()?.text ?? "";
    expect(text).toContain("lost my connection");
    expect(text).toContain("__boot_recovery__:reconnect=");
    expect(text).not.toContain("retry-handoff");
    act(() => {
      expect(tryHandleBootRecoveryAction("__boot_recovery__:reconnect")).toBe(
        true,
      );
    });
    expect(mocks.store.retryBackendConnection).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("defers the connection card when another surface owns the disconnected state", () => {
    mocks.store.backendConnection = {
      state: "failed",
      reconnectAttempt: 15,
      maxReconnectAttempts: 15,
      showDisconnectedUI: true,
    };
    const { card, unmount } = renderConductor({
      booting: false,
      noProviderConfigured: false,
      handoff: null,
    });
    expect(card()).toBeUndefined();
    unmount();
  });

  it("consumes unknown reserved-prefix values without seeding or sending", () => {
    const { card, unmount } = renderConductor({
      ...BOOTING,
      booting: false,
    });
    expect(tryHandleBootRecoveryAction("__boot_recovery__:bogus")).toBe(true);
    expect(tryHandleBootRecoveryAction("plain chat text")).toBe(false);
    expect(card()).toBeUndefined();
    unmount();
  });
});
