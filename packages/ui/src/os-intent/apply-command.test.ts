/**
 * Executor unit tests: each routed command drives the one controller's matching
 * method, send forwards its options, and the transcription toggle is idempotent
 * (never turns a live session off on a redelivered start). The controller is a
 * spy double of the narrow {@link IntentControllerTarget} surface the executor
 * touches. Deterministic; no I/O.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyOsIntentCommand,
  applyOsIntentCommands,
  type IntentControllerTarget,
} from "./apply-command";

function spyController(overrides: Partial<IntentControllerTarget> = {}): {
  controller: IntentControllerTarget;
  open: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  stopRecording: ReturnType<typeof vi.fn>;
  toggleTranscriptionMode: ReturnType<typeof vi.fn>;
  stopTranscriptionAndMic: ReturnType<typeof vi.fn>;
} {
  const open = vi.fn();
  const send = vi.fn();
  const startRecording = vi.fn();
  const stopRecording = vi.fn();
  const toggleTranscriptionMode = vi.fn();
  const stopTranscriptionAndMic = vi.fn();
  const controller: IntentControllerTarget = {
    open,
    send,
    startRecording,
    stopRecording,
    toggleTranscriptionMode,
    stopTranscriptionAndMic,
    transcriptionMode: false,
    ...overrides,
  };
  return {
    controller,
    open,
    send,
    startRecording,
    stopRecording,
    toggleTranscriptionMode,
    stopTranscriptionAndMic,
  };
}

describe("applyOsIntentCommand", () => {
  it("open → controller.open()", () => {
    const s = spyController();
    applyOsIntentCommand(s.controller, { kind: "open" });
    expect(s.open).toHaveBeenCalledTimes(1);
  });

  it("send → controller.send(text, options)", () => {
    const s = spyController();
    applyOsIntentCommand(s.controller, {
      kind: "send",
      text: "hi",
      channelType: "VOICE_DM",
    });
    expect(s.send).toHaveBeenCalledWith("hi", { channelType: "VOICE_DM" });
  });

  it("send with no options → empty options object", () => {
    const s = spyController();
    applyOsIntentCommand(s.controller, { kind: "send", text: "hi" });
    expect(s.send).toHaveBeenCalledWith("hi", {});
  });

  it("startRecording → controller.startRecording(intent)", () => {
    const s = spyController();
    applyOsIntentCommand(s.controller, {
      kind: "startRecording",
      intent: "dictate",
    });
    expect(s.startRecording).toHaveBeenCalledWith("dictate");
  });

  it("stopRecording → controller.stopRecording()", () => {
    const s = spyController();
    applyOsIntentCommand(s.controller, { kind: "stopRecording" });
    expect(s.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("toggleTranscriptionMode toggles ON when transcription is off", () => {
    const s = spyController({ transcriptionMode: false });
    applyOsIntentCommand(s.controller, { kind: "toggleTranscriptionMode" });
    expect(s.toggleTranscriptionMode).toHaveBeenCalledTimes(1);
  });

  it("toggleTranscriptionMode is a no-op when transcription is already on (idempotent)", () => {
    const s = spyController({ transcriptionMode: true });
    applyOsIntentCommand(s.controller, { kind: "toggleTranscriptionMode" });
    expect(s.toggleTranscriptionMode).not.toHaveBeenCalled();
  });

  it("stopTranscriptionAndMic → controller.stopTranscriptionAndMic()", () => {
    const s = spyController({ transcriptionMode: true });
    applyOsIntentCommand(s.controller, { kind: "stopTranscriptionAndMic" });
    expect(s.stopTranscriptionAndMic).toHaveBeenCalledTimes(1);
  });
});

describe("applyOsIntentCommands", () => {
  it("applies an ordered command list in sequence", () => {
    const s = spyController();
    const order: string[] = [];
    s.open.mockImplementation(() => order.push("open"));
    s.send.mockImplementation(() => order.push("send"));
    applyOsIntentCommands(s.controller, [
      { kind: "open" },
      { kind: "send", text: "hi" },
    ]);
    expect(order).toEqual(["open", "send"]);
  });
});
