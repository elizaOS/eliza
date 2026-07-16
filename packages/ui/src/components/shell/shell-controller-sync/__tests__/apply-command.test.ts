/** Owner-side command application: each typed command hits the matching engine
 *  method exactly once. */
import { describe, expect, it, vi } from "vitest";
import { applyShellControllerCommand } from "../apply-command";
import { makeFakeShellController } from "./fixtures";

describe("applyShellControllerCommand", () => {
  it("maps voice + chat commands to the engine", () => {
    const c = makeFakeShellController();
    applyShellControllerCommand(c, { kind: "open" });
    expect(c.open).toHaveBeenCalledTimes(1);

    applyShellControllerCommand(c, {
      kind: "send",
      text: "hello",
      channelType: "VOICE_DM",
      metadata: { a: 1 },
    });
    expect(c.send).toHaveBeenCalledWith("hello", {
      channelType: "VOICE_DM",
      metadata: { a: 1 },
    });

    applyShellControllerCommand(c, { kind: "startRecording", intent: "dictate" });
    expect(c.startRecording).toHaveBeenCalledWith("dictate");

    applyShellControllerCommand(c, { kind: "speak", text: "read this" });
    expect(c.speak).toHaveBeenCalledWith("read this");

    applyShellControllerCommand(c, { kind: "setComposerHasDraft", hasDraft: true });
    expect(c.setComposerHasDraft).toHaveBeenCalledWith(true);

    applyShellControllerCommand(c, { kind: "recheckMicPermission" });
    expect(c.recheckMicPermission).toHaveBeenCalledTimes(1);
  });

  it("routes nav prev/next to conversationNav", () => {
    const c = makeFakeShellController();
    applyShellControllerCommand(c, { kind: "navConversation", direction: "prev" });
    applyShellControllerCommand(c, { kind: "navConversation", direction: "next" });
    expect(c.conversationNav.goPrev).toHaveBeenCalledTimes(1);
    expect(c.conversationNav.goNext).toHaveBeenCalledTimes(1);
  });

  it("covers the remaining commands", () => {
    const c = makeFakeShellController();
    const kinds = [
      "close",
      "captureVision",
      "toggleRecording",
      "stopRecording",
      "toggleHandsFree",
      "toggleTranscriptionMode",
      "stopTranscriptionAndMic",
      "stopSpeaking",
      "toggleAgentVoiceMute",
      "unlockAudio",
      "clearConversation",
      "openSettings",
      "navigateHome",
      "stop",
    ] as const;
    for (const kind of kinds) applyShellControllerCommand(c, { kind });
    expect(c.close).toHaveBeenCalled();
    expect(c.captureVision).toHaveBeenCalled();
    expect(c.stop).toHaveBeenCalled();
    expect(c.navigateHome).toHaveBeenCalled();
  });

  it("tolerates a missing optional navigateHome", () => {
    const c = makeFakeShellController();
    (c as { navigateHome?: () => void }).navigateHome = undefined;
    expect(() => applyShellControllerCommand(c, { kind: "navigateHome" })).not.toThrow();
  });

  it("propagates an engine throw so the owner can fail the ack", () => {
    const c = makeFakeShellController();
    c.send = vi.fn(() => {
      throw new Error("send blew up");
    });
    expect(() =>
      applyShellControllerCommand(c, { kind: "send", text: "x" }),
    ).toThrow("send blew up");
  });
});
