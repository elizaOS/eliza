// @vitest-environment jsdom

// The in-chat model-status conductor, driven through its REAL public seams: the
// hook is mounted (registering handlers on the model action channel), the
// transcript is a real ref-backed provider, and control taps arrive via
// `tryHandleModelAction` exactly as the chat send funnel delivers them. Mocks
// sit only at the boundaries: the shared `client` singleton (cancel/download/
// policy calls) and `useHomeModelStatus` (the readiness snapshot, whose live
// value the test steps through rerenders).

import { act, renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeModelStatus } from "../services/local-inference/home-model-status";

const mocks = vi.hoisted(() => ({
  status: {
    kind: "downloading",
    blocksSend: true,
    percent: 20,
    etaMs: 60_000,
    modelName: "eliza-1-2b",
    modelId: "eliza-1-2b",
    errors: [] as string[],
  } as HomeModelStatus,
  client: {
    cancelLocalInferenceDownload: vi.fn(async () => ({ cancelled: true })),
    startLocalInferenceDownload: vi.fn(async () => ({ job: {} })),
    setLocalInferencePolicy: vi.fn(async () => ({ preferences: {} })),
  },
}));

vi.mock("../components/local-inference/useHomeModelStatus", () => ({
  useHomeModelStatus: () => mocks.status,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, client: mocks.client };
});

import type { ConversationMessage } from "../api";
import { __setAppValueForTests } from "../state/app-store";
import {
  ConversationMessagesCtx,
  type ConversationMessagesValue,
} from "../state/ConversationMessagesContext.hooks";
import type { AppContextValue } from "../state/internal";
import {
  notifyTypedWhileBlocked,
  tryHandleModelAction,
} from "./model-action-channel";
import { MODEL_ACTION, MODEL_STATUS_TURN_ID } from "./model-status-copy";
import { useModelStatusConductor } from "./use-model-status-conductor";

function setStatus(next: Partial<HomeModelStatus>): void {
  mocks.status = { ...mocks.status, ...next };
}

interface AppSpies {
  handleCloudLogin: ReturnType<typeof vi.fn>;
}

function seedAppStore(overrides: Record<string, unknown> = {}): AppSpies {
  const spies: AppSpies = {
    handleCloudLogin: vi.fn(async () => undefined),
  };
  const fields: Record<string, unknown> = {
    elizaCloudConnected: true,
    ...spies,
    ...overrides,
  };
  const noop = () => {};
  const value = new Proxy({} as AppContextValue, {
    get: (_t, prop) =>
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
  const utils = renderHook(() => useModelStatusConductor(), { wrapper });
  const turn = (id: string) => transcript.current.find((m) => m.id === id);
  return { transcript, turn, ...utils };
}

async function waitForTurn(
  turn: (id: string) => ConversationMessage | undefined,
  id: string,
): Promise<ConversationMessage> {
  await waitFor(() => expect(turn(id)).toBeTruthy());
  const found = turn(id);
  if (!found) throw new Error(`turn ${id} not seeded`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  setStatus({
    kind: "downloading",
    blocksSend: true,
    percent: 20,
    etaMs: 60_000,
    modelName: "eliza-1-2b",
    modelId: "eliza-1-2b",
    errors: [],
  });
});

afterEach(() => {
  __setAppValueForTests(null);
});

describe("useModelStatusConductor", () => {
  it("seeds ONE live status turn while the model is downloading", async () => {
    seedAppStore();
    const { turn, transcript } = renderConductor();

    const t = await waitForTurn(turn, MODEL_STATUS_TURN_ID);
    expect(t.text).toContain("eliza-1-2b");
    expect(t.text).toContain("20%");
    expect(t.text).toContain(`${MODEL_ACTION.cancel}=`);
    // Exactly one status turn, not one bubble per tick.
    expect(
      transcript.current.filter((m) => m.id === MODEL_STATUS_TURN_ID),
    ).toHaveLength(1);
  });

  it("clears the turn and unblocks once the model is ready", async () => {
    seedAppStore();
    const { turn, rerender } = renderConductor();
    await waitForTurn(turn, MODEL_STATUS_TURN_ID);

    act(() => setStatus({ kind: "ready", blocksSend: false }));
    rerender();
    await waitFor(() => expect(turn(MODEL_STATUS_TURN_ID)).toBeUndefined());
  });

  it("cancel calls the cancel API and flips the turn to a non-dead-end", async () => {
    seedAppStore();
    const { turn } = renderConductor();
    await waitForTurn(turn, MODEL_STATUS_TURN_ID);

    await act(async () => {
      expect(tryHandleModelAction(MODEL_ACTION.cancel)).toBe(true);
    });
    await waitFor(() =>
      expect(mocks.client.cancelLocalInferenceDownload).toHaveBeenCalledWith(
        "eliza-1-2b",
      ),
    );
    await waitFor(() => {
      const t = turn(MODEL_STATUS_TURN_ID);
      expect(t?.text.toLowerCase()).toContain("cancelled");
      expect(t?.text).toContain(`${MODEL_ACTION.download}=`);
    });
  });

  it("retry re-enqueues the failed model download", async () => {
    seedAppStore();
    setStatus({ kind: "error", blocksSend: true, errors: ["disk full"] });
    const { turn } = renderConductor();
    const t = await waitForTurn(turn, MODEL_STATUS_TURN_ID);
    expect(t.text).toContain(`${MODEL_ACTION.retry}=`);

    await act(async () => {
      expect(tryHandleModelAction(MODEL_ACTION.retry)).toBe(true);
    });
    await waitFor(() =>
      expect(mocks.client.startLocalInferenceDownload).toHaveBeenCalledWith(
        "eliza-1-2b",
      ),
    );
  });

  it("switch-cloud forces cloud-only routing on the text slots", async () => {
    seedAppStore({ elizaCloudConnected: true });
    const { turn } = renderConductor();
    await waitForTurn(turn, MODEL_STATUS_TURN_ID);

    await act(async () => {
      expect(tryHandleModelAction(MODEL_ACTION.switchCloud)).toBe(true);
    });
    await waitFor(() =>
      expect(mocks.client.setLocalInferencePolicy).toHaveBeenCalledWith(
        "TEXT_LARGE",
        "cloud-only",
      ),
    );
    expect(mocks.client.setLocalInferencePolicy).toHaveBeenCalledWith(
      "TEXT_SMALL",
      "cloud-only",
    );
  });

  it("switch-cloud opens login first when not connected", async () => {
    const spies = seedAppStore({ elizaCloudConnected: false });
    const { turn } = renderConductor();
    await waitForTurn(turn, MODEL_STATUS_TURN_ID);

    await act(async () => {
      tryHandleModelAction(MODEL_ACTION.switchCloud);
    });
    await waitFor(() => expect(spies.handleCloudLogin).toHaveBeenCalled());
    // Still disconnected after login → no policy write (no silent half-switch).
    expect(mocks.client.setLocalInferencePolicy).not.toHaveBeenCalled();
  });

  it("acknowledges a typed message while blocked so it is not lost", async () => {
    seedAppStore();
    const { turn, transcript } = renderConductor();
    await waitForTurn(turn, MODEL_STATUS_TURN_ID);

    act(() => {
      expect(notifyTypedWhileBlocked()).toBe(true);
    });
    const ack = transcript.current.find((m) => m.id.startsWith("model:ack:"));
    expect(ack?.text.toLowerCase()).toContain("still getting");
  });

  it("does not acknowledge when the model is ready (send not blocked)", async () => {
    seedAppStore();
    setStatus({ kind: "ready", blocksSend: false });
    renderConductor();
    act(() => {
      expect(notifyTypedWhileBlocked()).toBe(false);
    });
  });
});
