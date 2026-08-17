/** Follower controller: reads come from the snapshot, methods forward typed
 *  commands, engine-only affordances are inert, dispatch failures surface. */
import { describe, expect, it, vi } from "vitest";
import { buildFollowerController } from "../follower-controller";
import type { ShellControllerCommand } from "../protocol";
import { baseSnapshot } from "./fixtures";

function build(over = {}): {
  controller: ReturnType<typeof buildFollowerController>;
  dispatch: ReturnType<typeof vi.fn>;
  setDictationSink: ReturnType<typeof vi.fn>;
  setTranscriptSessionSink: ReturnType<typeof vi.fn>;
  errors: { command: ShellControllerCommand; error: unknown }[];
} {
  const dispatch = vi.fn(async () => {});
  const setDictationSink = vi.fn();
  const setTranscriptSessionSink = vi.fn();
  const errors: { command: ShellControllerCommand; error: unknown }[] = [];
  const controller = buildFollowerController({
    snapshot: baseSnapshot(over),
    dispatch,
    onCommandError: (command, error) => errors.push({ command, error }),
    setDictationSink,
    setTranscriptSessionSink,
  });
  return {
    controller,
    dispatch,
    setDictationSink,
    setTranscriptSessionSink,
    errors,
  };
}

describe("buildFollowerController reads", () => {
  it("mirrors snapshot fields and owns no analyser", () => {
    const { controller } = build({
      recording: true,
      transcript: "live",
      handsFree: true,
      authGate: { gated: true, phase: "needs-auth" },
      signingIn: true,
    });
    expect(controller.recording).toBe(true);
    expect(controller.transcript).toBe("live");
    expect(controller.handsFree).toBe(true);
    expect(controller.authGate).toEqual({ gated: true, phase: "needs-auth" });
    expect(controller.signingIn).toBe(true);
    expect(controller.analyser).toBeNull();
  });

  it("mirrors realtime voice phase and forwards microphone mute", () => {
    const { controller, dispatch } = build({
      realtimeVoice: {
        enabled: true,
        active: true,
        connecting: false,
        paused: false,
        microphoneMuted: false,
        status: "thinking",
        error: null,
      },
    });
    expect(controller.realtimeVoice?.status).toBe("thinking");
    controller.realtimeVoice?.toggleMicrophoneMute();
    expect(dispatch).toHaveBeenCalledWith({
      kind: "toggleRealtimeVoiceMicrophoneMute",
    });
  });
});

describe("buildFollowerController commands", () => {
  it("forwards send with serialisable options", () => {
    const { controller, dispatch } = build();
    controller.send("hi", { channelType: "VOICE_DM", metadata: { x: 1 } });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "send",
      text: "hi",
      channelType: "VOICE_DM",
      metadata: { x: 1 },
    });
  });

  it("forwards voice + nav controls", () => {
    const { controller, dispatch } = build();
    controller.startRecording("dictate");
    controller.requestSignIn();
    controller.toggleHandsFree();
    controller.conversationNav.goNext();
    expect(dispatch).toHaveBeenCalledWith({
      kind: "startRecording",
      intent: "dictate",
    });
    expect(dispatch).toHaveBeenCalledWith({ kind: "requestSignIn" });
    expect(dispatch).toHaveBeenCalledWith({ kind: "toggleHandsFree" });
    expect(dispatch).toHaveBeenCalledWith({
      kind: "navConversation",
      direction: "next",
    });
  });

  it("registers sinks in the initiating follower window", () => {
    const { controller, dispatch, setDictationSink, setTranscriptSessionSink } =
      build();
    const dictation = () => {};
    const transcript = () => {};
    controller.setDictationSink(dictation);
    controller.setTranscriptSessionSink(transcript);
    expect(dispatch).not.toHaveBeenCalled();
    expect(setDictationSink).toHaveBeenCalledWith(dictation);
    expect(setTranscriptSessionSink).toHaveBeenCalledWith(transcript);
  });

  it("recheckMicPermission forwards and resolves the known permission", async () => {
    const { controller, dispatch } = build({ micPermission: "denied" });
    await expect(controller.recheckMicPermission()).resolves.toBe("denied");
    expect(dispatch).toHaveBeenCalledWith({ kind: "recheckMicPermission" });
  });

  it("routes a dispatch failure to onCommandError (never silent)", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("owner gone");
    });
    const errors: unknown[] = [];
    const controller = buildFollowerController({
      snapshot: baseSnapshot(),
      dispatch,
      onCommandError: (_command, error) => errors.push(error),
      setDictationSink: vi.fn(),
      setTranscriptSessionSink: vi.fn(),
    });
    controller.stop();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect((errors[0] as Error).message).toBe("owner gone");
  });
});
