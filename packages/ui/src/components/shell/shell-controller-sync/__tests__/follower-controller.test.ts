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

  it("passes the failing command itself to onCommandError", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("timed out");
    });
    const errors: { command: ShellControllerCommand; error: unknown }[] = [];
    const controller = buildFollowerController({
      snapshot: baseSnapshot(),
      dispatch,
      onCommandError: (command, error) => errors.push({ command, error }),
      setDictationSink: vi.fn(),
      setTranscriptSessionSink: vi.fn(),
    });
    controller.open();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].command).toEqual({ kind: "open" });
    expect((errors[0].error as Error).message).toBe("timed out");
  });
});

describe("buildFollowerController nav mirroring", () => {
  it("mirrors conversationNav data and forwards goPrev", () => {
    const { controller, dispatch } = build({
      conversationNav: {
        hasPrev: true,
        hasNext: true,
        activeId: "c7",
        index: 3,
      },
    });
    expect(controller.conversationNav.hasPrev).toBe(true);
    expect(controller.conversationNav.hasNext).toBe(true);
    expect(controller.conversationNav.activeId).toBe("c7");
    expect(controller.conversationNav.index).toBe(3);
    controller.conversationNav.goPrev();
    expect(dispatch).toHaveBeenCalledWith({
      kind: "navConversation",
      direction: "prev",
    });
  });
});

describe("buildFollowerController send option branches", () => {
  function capture(): {
    sent: ShellControllerCommand[];
    dispatch: (command: ShellControllerCommand) => Promise<void>;
  } {
    const sent: ShellControllerCommand[] = [];
    return {
      sent,
      dispatch: async (command) => {
        sent.push(command);
      },
    };
  }

  it("omits every optional key when send carries no options", () => {
    const { sent, dispatch } = capture();
    const controller = buildFollowerController({
      snapshot: baseSnapshot(),
      dispatch,
      onCommandError: () => {},
      setDictationSink: vi.fn(),
      setTranscriptSessionSink: vi.fn(),
    });
    controller.send("hi");
    expect(sent).toEqual([{ kind: "send", text: "hi" }]);
    expect(Object.keys(sent[0]).sort()).toEqual(["kind", "text"]);
  });

  it("forwards images while omitting channelType and metadata keys", () => {
    const { sent, dispatch } = capture();
    const controller = buildFollowerController({
      snapshot: baseSnapshot(),
      dispatch,
      onCommandError: () => {},
      setDictationSink: vi.fn(),
      setTranscriptSessionSink: vi.fn(),
    });
    controller.send("look", {
      images: [
        {
          data: "data:image/png;base64,AA",
          mimeType: "image/png",
          name: "shot.png",
        },
      ],
    });
    expect(sent[0]).toEqual({
      kind: "send",
      text: "look",
      images: [
        {
          data: "data:image/png;base64,AA",
          mimeType: "image/png",
          name: "shot.png",
        },
      ],
    });
    expect(Object.keys(sent[0]).sort()).toEqual(["images", "kind", "text"]);
  });

  it("forwards channelType alone when it is the only option", () => {
    const { sent, dispatch } = capture();
    const controller = buildFollowerController({
      snapshot: baseSnapshot(),
      dispatch,
      onCommandError: () => {},
      setDictationSink: vi.fn(),
      setTranscriptSessionSink: vi.fn(),
    });
    controller.send("hi", { channelType: "DM" });
    expect(sent[0]).toEqual({ kind: "send", text: "hi", channelType: "DM" });
    expect(Object.keys(sent[0]).sort()).toEqual([
      "channelType",
      "kind",
      "text",
    ]);
  });
});

describe("buildFollowerController startRecording intent branch", () => {
  it("omits the intent key for a bare startRecording", () => {
    const { controller, dispatch } = build();
    controller.startRecording();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: "startRecording" });
  });
});

describe("buildFollowerController remaining reads", () => {
  it("mirrors the rest of the snapshot surface", () => {
    const { controller } = build({
      phase: "listening",
      isOpen: true,
      responding: true,
      canSend: false,
      waveformMode: "listening",
      visionCapturing: true,
      speaking: true,
      agentVoiceMuted: true,
      needsAudioUnlock: true,
      transcriptionMode: true,
      currentTab: "chat",
      conversationLoading: true,
      noProviderConfigured: true,
      bootProgressSignal: "boot-1",
    });
    expect(controller.phase).toBe("listening");
    expect(controller.isOpen).toBe(true);
    expect(controller.responding).toBe(true);
    expect(controller.canSend).toBe(false);
    expect(controller.waveformMode).toBe("listening");
    expect(controller.visionCapturing).toBe(true);
    expect(controller.speaking).toBe(true);
    expect(controller.agentVoiceMuted).toBe(true);
    expect(controller.needsAudioUnlock).toBe(true);
    expect(controller.transcriptionMode).toBe(true);
    expect(controller.currentTab).toBe("chat");
    expect(controller.conversationLoading).toBe(true);
    expect(controller.noProviderConfigured).toBe(true);
    expect(controller.bootProgressSignal).toBe("boot-1");
    expect(controller.turnStatus).toBeNull();
    expect(controller.modelStatus.kind).toBe("not-required");
  });
});

describe("buildFollowerController forwards every owner command", () => {
  type Ctl = ReturnType<typeof buildFollowerController>;
  const rows: {
    m: string;
    run: (c: Ctl) => void;
    cmd: ShellControllerCommand;
  }[] = [
    { m: "open", run: (c) => c.open(), cmd: { kind: "open" } },
    { m: "close", run: (c) => c.close(), cmd: { kind: "close" } },
    {
      m: "captureVision",
      run: (c) => c.captureVision(),
      cmd: { kind: "captureVision" },
    },
    {
      m: "toggleRecording",
      run: (c) => c.toggleRecording(),
      cmd: { kind: "toggleRecording" },
    },
    {
      m: "stopRecording",
      run: (c) => c.stopRecording(),
      cmd: { kind: "stopRecording" },
    },
    {
      m: "cancelRecording",
      run: (c) => c.cancelRecording(),
      cmd: { kind: "cancelRecording" },
    },
    {
      m: "toggleHandsFree",
      run: (c) => c.toggleHandsFree(),
      cmd: { kind: "toggleHandsFree" },
    },
    {
      m: "toggleTranscriptionMode",
      run: (c) => c.toggleTranscriptionMode(),
      cmd: { kind: "toggleTranscriptionMode" },
    },
    {
      m: "stopTranscriptionAndMic",
      run: (c) => c.stopTranscriptionAndMic(),
      cmd: { kind: "stopTranscriptionAndMic" },
    },
    {
      m: "stopSpeaking",
      run: (c) => c.stopSpeaking(),
      cmd: { kind: "stopSpeaking" },
    },
    {
      m: "toggleAgentVoiceMute",
      run: (c) => c.toggleAgentVoiceMute(),
      cmd: { kind: "toggleAgentVoiceMute" },
    },
    {
      m: "unlockAudio",
      run: (c) => c.unlockAudio(),
      cmd: { kind: "unlockAudio" },
    },
    {
      m: "clearConversation",
      run: (c) => c.clearConversation(),
      cmd: { kind: "clearConversation" },
    },
    {
      m: "openSettings",
      run: (c) => c.openSettings(),
      cmd: { kind: "openSettings" },
    },
    {
      m: "navigateHome",
      run: (c) => c.navigateHome?.(),
      cmd: { kind: "navigateHome" },
    },
    { m: "stop", run: (c) => c.stop(), cmd: { kind: "stop" } },
    {
      m: "speak",
      run: (c) => c.speak("hello"),
      cmd: { kind: "speak", text: "hello" },
    },
    {
      m: "setComposerHasDraft",
      run: (c) => c.setComposerHasDraft(false),
      cmd: { kind: "setComposerHasDraft", hasDraft: false },
    },
  ];

  it.each(rows)("$m forwards its command exactly once", ({ run, cmd }) => {
    const { controller, dispatch } = build();
    run(controller);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(cmd);
  });
});
