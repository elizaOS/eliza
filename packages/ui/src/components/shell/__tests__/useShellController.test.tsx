// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useShellController } from "../useShellController";

const NOT_REQUIRED_STATUS = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: [],
};

const appMock = vi.hoisted(() => ({
  value: {
    startupCoordinator: { phase: "ready" },
    conversationMessages: [],
    chatSending: false,
    sendChatText: vi.fn(),
    agentStatus: { state: "running" },
  },
}));

vi.mock("../../../state", () => ({
  useApp: () => appMock.value,
}));

vi.mock("../../local-inference/useHomeModelStatus", () => ({
  useHomeModelStatus: () => NOT_REQUIRED_STATUS,
}));

vi.mock("../../../voice/voice-capture-factory", () => ({
  createVoiceCapture: vi.fn(),
}));

afterEach(() => {
  cleanup();
  appMock.value.startupCoordinator.phase = "ready";
  appMock.value.conversationMessages = [];
  appMock.value.chatSending = false;
  appMock.value.sendChatText.mockClear();
  appMock.value.agentStatus = { state: "running" };
});

describe("useShellController", () => {
  it("opens the shared chat state even while startup is still booting", () => {
    appMock.value.startupCoordinator.phase = "starting-runtime";

    const { result } = renderHook(() => useShellController());

    expect(result.current.phase).toBe("booting");
    expect(result.current.isOpen).toBe(false);

    act(() => result.current.open());

    expect(result.current.phase).toBe("booting");
    expect(result.current.isOpen).toBe(true);
    // Composer accepts input while booting — pre-ready sends queue (see below).
    expect(result.current.canSend).toBe(true);
  });

  it("queues a send while booting and flushes it once ready", () => {
    appMock.value.startupCoordinator.phase = "starting-runtime";

    const { result, rerender } = renderHook(() => useShellController());

    act(() => result.current.send("hello while booting"));
    // Queued, not sent yet.
    expect(appMock.value.sendChatText).not.toHaveBeenCalled();

    // Agent becomes ready — the queued message flushes.
    appMock.value.startupCoordinator.phase = "ready";
    rerender();

    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
    expect(appMock.value.sendChatText).toHaveBeenCalledWith(
      "hello while booting",
    );
  });

  it("sends immediately when already ready", () => {
    appMock.value.startupCoordinator.phase = "ready";

    const { result } = renderHook(() => useShellController());

    act(() => result.current.send("hi"));

    expect(appMock.value.sendChatText).toHaveBeenCalledTimes(1);
    expect(appMock.value.sendChatText).toHaveBeenCalledWith("hi");
  });
});
