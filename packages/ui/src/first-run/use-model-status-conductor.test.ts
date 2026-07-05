// @vitest-environment jsdom

/**
 * The in-chat model-status conductor, driven through its real seams: the hook
 * is mounted with a HomeModelStatus, seeds/refreshes ONE `model:download-status`
 * turn into the transcript, and its `__model__:` controls arrive via
 * `tryHandleModelAction` exactly as the chat send funnel delivers them. Mocks
 * sit only at the network boundary (the shared `client` singleton).
 */

import { renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    cancelLocalInferenceDownload: vi.fn(async () => ({ cancelled: true })),
    startLocalInferenceDownload: vi.fn(async () => ({ job: { id: "j1" } })),
    setLocalInferencePreferredProvider: vi.fn(async () => ({
      preferences: {},
    })),
  },
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, client: mocks.client };
});

import type { ConversationMessage } from "../api";
import type { HomeModelStatus } from "../services/local-inference/home-model-status";
import {
  ConversationMessagesCtx,
  type ConversationMessagesValue,
} from "../state/ConversationMessagesContext.hooks";
import { tryHandleModelAction } from "./model-action-channel";
import { useModelStatusConductor } from "./use-model-status-conductor";

function status(overrides: Partial<HomeModelStatus>): HomeModelStatus {
  return {
    kind: "not-required",
    blocksSend: false,
    percent: null,
    etaMs: null,
    modelName: null,
    modelId: null,
    errors: [],
    ...overrides,
  };
}

const DOWNLOADING = status({
  kind: "downloading",
  blocksSend: true,
  percent: 42,
  etaMs: 120_000,
  modelName: "eliza-1-2b",
  modelId: "eliza-1-2b",
});

function renderConductor(initial: HomeModelStatus) {
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
  const utils = renderHook((s: HomeModelStatus) => useModelStatusConductor(s), {
    wrapper,
    initialProps: initial,
  });
  const card = (): ConversationMessage | undefined =>
    transcript.current.find((m) => m.id === "model:download-status");
  return { transcript, card, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Clear the module-scoped action handler between cases.
  tryHandleModelAction("noop"); // no-op (non-prefixed) — safe
});

describe("useModelStatusConductor", () => {
  it("seeds ONE live status card while downloading, with name, %, and controls", async () => {
    const { card, unmount } = renderConductor(DOWNLOADING);
    await waitFor(() => expect(card()).toBeTruthy());
    const turn = card();
    expect(turn?.text).toContain("Downloading eliza-1-2b");
    expect(turn?.text).toContain("42%");
    expect(turn?.text).toContain("__model__:cancel=");
    expect(turn?.text).toContain("__model__:switch-cloud=");
    expect(turn?.source).toBe("model_status");
    unmount();
  });

  it("clamps the displayed percent monotonically (a regressing snapshot never rewinds)", async () => {
    const { card, rerender, unmount } = renderConductor(DOWNLOADING);
    await waitFor(() => expect(card()?.text).toContain("42%"));
    // A later snapshot reports a LOWER percent (known local-inference quirk).
    rerender(status({ ...DOWNLOADING, percent: 30 }));
    await waitFor(() => expect(card()).toBeTruthy());
    expect(card()?.text).toContain("42%");
    expect(card()?.text).not.toContain("30%");
    // A higher percent advances.
    rerender(status({ ...DOWNLOADING, percent: 88 }));
    await waitFor(() => expect(card()?.text).toContain("88%"));
    unmount();
  });

  it("removes the card once the model is ready", async () => {
    const { card, rerender, unmount } = renderConductor(DOWNLOADING);
    await waitFor(() => expect(card()).toBeTruthy());
    rerender(status({ kind: "ready", modelName: "eliza-1-2b" }));
    await waitFor(() => expect(card()).toBeUndefined());
    unmount();
  });

  it("cancel → DELETEs the download and flips the card to a 'cancelled' chooser", async () => {
    const { card, unmount } = renderConductor(DOWNLOADING);
    await waitFor(() => expect(card()).toBeTruthy());
    tryHandleModelAction("__model__:cancel");
    await waitFor(() =>
      expect(mocks.client.cancelLocalInferenceDownload).toHaveBeenCalledWith(
        "eliza-1-2b",
      ),
    );
    expect(card()?.text).toContain("cancelled");
    expect(card()?.text).toContain("__model__:download=");
    unmount();
  });

  it("switch-cloud → routes both text slots to elizacloud", async () => {
    const { card, unmount } = renderConductor(DOWNLOADING);
    await waitFor(() => expect(card()).toBeTruthy());
    tryHandleModelAction("__model__:switch-cloud");
    await waitFor(() =>
      expect(
        mocks.client.setLocalInferencePreferredProvider,
      ).toHaveBeenCalledWith("TEXT_LARGE", "elizacloud"),
    );
    expect(
      mocks.client.setLocalInferencePreferredProvider,
    ).toHaveBeenCalledWith("TEXT_SMALL", "elizacloud");
    expect(card()?.text).toContain("Eliza Cloud");
    unmount();
  });

  it("retry (from an error card) → restarts the download", async () => {
    const ERROR = status({
      kind: "error",
      blocksSend: true,
      modelName: "eliza-1-2b",
      modelId: "eliza-1-2b",
      errors: ["disk full"],
    });
    const { card, unmount } = renderConductor(ERROR);
    await waitFor(() => expect(card()?.text).toContain("disk full"));
    expect(card()?.text).toContain("__model__:retry=");
    tryHandleModelAction("__model__:retry");
    await waitFor(() =>
      expect(mocks.client.startLocalInferenceDownload).toHaveBeenCalledWith(
        "eliza-1-2b",
      ),
    );
    unmount();
  });
});
