/** Strict native-authority wire decoders reject malformed commands, state, and
 * targeted voice deliveries before they reach controller state. */
import { describe, expect, it } from "vitest";
import {
  parseShellAuthorityCommandRequest,
  parseShellAuthorityDelivery,
  parseShellAuthorityState,
  parseShellControllerCommand,
} from "../protocol";

describe("shell authority protocol decoders", () => {
  it("accepts every structured command form and rejects forged input", () => {
    expect(parseShellControllerCommand({ kind: "stop" })).toEqual({
      kind: "stop",
    });
    expect(
      parseShellControllerCommand({
        kind: "send",
        text: "hello",
        channelType: "VOICE_DM",
      }),
    ).toEqual({ kind: "send", text: "hello", channelType: "VOICE_DM" });
    expect(parseShellControllerCommand({ kind: "send", text: 4 })).toBeNull();
    expect(
      parseShellControllerCommand({
        kind: "send",
        text: "hello",
        images: [{ data: 4, mimeType: "image/png", name: "bad" }],
      }),
    ).toBeNull();
    expect(
      parseShellControllerCommand({ kind: "startRecording", intent: "root" }),
    ).toBeNull();
    expect(
      parseShellControllerCommand({
        kind: "routeOsIntent",
        intent: {
          type: "start-voice",
          intentId: "launch-1",
          source: "ios-app-intents",
          mode: "converse",
        },
        deliveryPolicy: "execute",
      }),
    ).toEqual({
      kind: "routeOsIntent",
      intent: {
        type: "start-voice",
        intentId: "launch-1",
        source: "ios-app-intents",
        mode: "converse",
      },
      deliveryPolicy: "execute",
    });
    expect(
      parseShellControllerCommand({
        kind: "routeOsIntent",
        intent: {
          type: "start-voice",
          intentId: "launch-1",
          source: "forged",
          mode: "converse",
        },
        deliveryPolicy: "execute",
      }),
    ).toBeNull();
  });

  it("requires complete authority identity and generation fields", () => {
    const state = {
      endpointId: "shell-2",
      ownerEndpointId: "shell-1",
      generation: 2,
      role: "follower",
      status: "connected",
      snapshotSeq: 8,
      snapshot: null,
    };
    expect(parseShellAuthorityState(state)).toEqual(state);
    expect(parseShellAuthorityState({ ...state, generation: -1 })).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({
        generation: 2,
        commandId: "command-1",
        fromEndpointId: "shell-2",
        command: { kind: "stop" },
      }),
    ).not.toBeNull();
  });

  it("validates targeted dictation and transcript-session payloads", () => {
    expect(
      parseShellAuthorityDelivery({ kind: "dictation", text: "hello" }),
    ).toEqual({ kind: "dictation", text: "hello" });
    expect(
      parseShellAuthorityDelivery({
        kind: "composer-prefill",
        text: "review me",
      }),
    ).toEqual({ kind: "composer-prefill", text: "review me" });
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [
          { id: "s1", text: "hello", startMs: 0, endMs: 100, words: [] },
        ],
        startedAtMs: 1,
        audioWav: null,
      }),
    ).not.toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [{ id: "s1" }],
        startedAtMs: 1,
        audioWav: null,
      }),
    ).toBeNull();
  });
});

/** Branch-level edge coverage beyond the happy-path suite above: size caps,
 * discriminated-union members, passthrough shapes, and hostile payloads are
 * each pinned to the decoder's observed contract. */
describe("shell authority protocol decoder edge branches", () => {
  it("rejects non-record inputs and unknown or missing command kinds", () => {
    expect(parseShellControllerCommand(null)).toBeNull();
    expect(parseShellControllerCommand(undefined)).toBeNull();
    expect(parseShellControllerCommand("open")).toBeNull();
    expect(parseShellControllerCommand(42)).toBeNull();
    expect(parseShellControllerCommand(["open"])).toBeNull();
    expect(parseShellControllerCommand({})).toBeNull();
    expect(parseShellControllerCommand({ kind: 7 })).toBeNull();
    expect(parseShellControllerCommand({ kind: "teleport" })).toBeNull();
  });

  it("maps every argument-free command kind and drops stray extras", () => {
    const noArgKinds = [
      "open",
      "requestSignIn",
      "close",
      "captureVision",
      "toggleRecording",
      "stopRecording",
      "cancelRecording",
      "toggleHandsFree",
      "toggleTranscriptionMode",
      "stopTranscriptionAndMic",
      "recheckMicPermission",
      "stopSpeaking",
      "toggleAgentVoiceMute",
      "unlockAudio",
      "clearConversation",
      "openSettings",
      "navigateHome",
      "stop",
    ] as const;
    for (const kind of noArgKinds) {
      expect(parseShellControllerCommand({ kind })).toStrictEqual({ kind });
    }
    expect(
      parseShellControllerCommand({ kind: "open", forged: true }),
    ).toStrictEqual({ kind: "open" });
  });

  it("enforces the send text cap and optional field shapes", () => {
    const maxText = "x".repeat(1_000_000);
    expect(
      parseShellControllerCommand({ kind: "send", text: maxText }),
    ).toStrictEqual({ kind: "send", text: maxText });
    expect(
      parseShellControllerCommand({ kind: "send", text: `${maxText}!` }),
    ).toBeNull();

    // Optional fields absent from the wire are omitted from the parsed value.
    expect(
      parseShellControllerCommand({ kind: "send", text: "t" }),
    ).toStrictEqual({ kind: "send", text: "t" });

    expect(
      parseShellControllerCommand({
        kind: "send",
        text: "t",
        channelType: "DM",
      }),
    ).toStrictEqual({ kind: "send", text: "t", channelType: "DM" });
    expect(
      parseShellControllerCommand({
        kind: "send",
        text: "t",
        channelType: "GROUP",
      }),
    ).toBeNull();

    const metadata = { thread: "a", depth: 2 };
    expect(
      parseShellControllerCommand({
        kind: "send",
        text: "t",
        metadata,
      }),
    ).toStrictEqual({ kind: "send", text: "t", metadata });
    expect(
      parseShellControllerCommand({
        kind: "send",
        text: "t",
        metadata: ["a"],
      }),
    ).toBeNull();
  });

  it("validates image attachments field-by-field and caps the batch at 32", () => {
    const goodImage = {
      data: "Zm9v",
      mimeType: "image/png",
      name: "shot.png",
    };
    const sendWith = (images: unknown) =>
      parseShellControllerCommand({ kind: "send", text: "t", images });

    expect(sendWith([goodImage])).toStrictEqual({
      kind: "send",
      text: "t",
      images: [goodImage],
    });
    expect(sendWith("shot.png")).toBeNull();

    const manyValid = Array.from({ length: 33 }, (_, i) => ({
      ...goodImage,
      name: `shot-${i}.png`,
    }));
    expect(sendWith(manyValid)).toBeNull();
    expect(sendWith(manyValid.slice(0, 32))).not.toBeNull();

    expect(sendWith([{ ...goodImage, mimeType: "" }])).toBeNull();
    expect(sendWith([{ ...goodImage, mimeType: "i".repeat(257) }])).toBeNull();
    expect(sendWith([{ ...goodImage, name: "" }])).toBeNull();
    expect(sendWith([{ ...goodImage, name: "n".repeat(2001) }])).toBeNull();
    expect(
      sendWith([{ ...goodImage, data: "d".repeat(32_000_001) }]),
    ).toBeNull();
    expect(sendWith([{ ...goodImage, transcriptId: "" }])).toBeNull();
    expect(sendWith([{ ...goodImage, transcriptId: "seg-1" }])).not.toBeNull();
    expect(
      sendWith([
        { ...goodImage, thumbnail: { data: 1, mimeType: "image/png" } },
      ]),
    ).toBeNull();
    expect(
      sendWith([
        { ...goodImage, thumbnail: { data: "QQ==", mimeType: "image/jpeg" } },
      ]),
    ).not.toBeNull();
  });

  it("keeps every valid startRecording intent and passes the value through verbatim", () => {
    for (const intent of ["converse", "dictate", "transcription", "ptt"]) {
      expect(
        parseShellControllerCommand({ kind: "startRecording", intent }),
      ).toStrictEqual({ kind: "startRecording", intent });
    }
    expect(
      parseShellControllerCommand({ kind: "startRecording" }),
    ).toStrictEqual({ kind: "startRecording" });
    expect(
      parseShellControllerCommand({
        kind: "startRecording",
        intent: "ptt",
        extra: 1,
      }),
    ).toStrictEqual({ kind: "startRecording", intent: "ptt", extra: 1 });
    expect(
      parseShellControllerCommand({ kind: "startRecording", intent: "loop" }),
    ).toBeNull();
  });

  it("bounds speak text and requires exact boolean and navigation fields", () => {
    const maxText = "y".repeat(1_000_000);
    expect(
      parseShellControllerCommand({ kind: "speak", text: maxText }),
    ).toStrictEqual({ kind: "speak", text: maxText });
    expect(
      parseShellControllerCommand({ kind: "speak", text: `${maxText}!` }),
    ).toBeNull();
    expect(parseShellControllerCommand({ kind: "speak" })).toBeNull();
    expect(parseShellControllerCommand({ kind: "speak", text: 4 })).toBeNull();

    expect(
      parseShellControllerCommand({
        kind: "setComposerHasDraft",
        hasDraft: true,
      }),
    ).toStrictEqual({ kind: "setComposerHasDraft", hasDraft: true });
    expect(
      parseShellControllerCommand({
        kind: "setComposerHasDraft",
        hasDraft: false,
      }),
    ).toStrictEqual({ kind: "setComposerHasDraft", hasDraft: false });
    expect(
      parseShellControllerCommand({
        kind: "setComposerHasDraft",
        hasDraft: "yes",
      }),
    ).toBeNull();

    expect(
      parseShellControllerCommand({
        kind: "navConversation",
        direction: "prev",
      }),
    ).toStrictEqual({ kind: "navConversation", direction: "prev" });
    expect(
      parseShellControllerCommand({
        kind: "navConversation",
        direction: "next",
      }),
    ).toStrictEqual({ kind: "navConversation", direction: "next" });
    expect(
      parseShellControllerCommand({ kind: "navConversation", direction: "up" }),
    ).toBeNull();
  });

  it("requires a known delivery policy on routeOsIntent commands", () => {
    const intent = {
      type: "start-voice",
      intentId: "launch-1",
      source: "ios-app-intents",
      mode: "converse",
    };
    expect(
      parseShellControllerCommand({
        kind: "routeOsIntent",
        intent,
        deliveryPolicy: "review-send",
      }),
    ).toStrictEqual({
      kind: "routeOsIntent",
      intent,
      deliveryPolicy: "review-send",
    });
    expect(
      parseShellControllerCommand({ kind: "routeOsIntent", intent }),
    ).toBeNull();
    expect(
      parseShellControllerCommand({
        kind: "routeOsIntent",
        intent,
        deliveryPolicy: "auto",
      }),
    ).toBeNull();
  });

  it("pins the published wire protocol version", async () => {
    const { SHELL_SYNC_PROTOCOL_VERSION } = await import("../protocol");
    expect(SHELL_SYNC_PROTOCOL_VERSION).toBe("3");
  });

  it("validates every authority-state field and strips unknown keys", () => {
    const state = {
      endpointId: "shell-2",
      ownerEndpointId: null,
      generation: 0,
      role: "owner",
      status: "version-mismatch",
      snapshotSeq: 0,
      snapshot: { seq: 1 },
    };
    expect(parseShellAuthorityState(state)).toStrictEqual(state);

    expect(parseShellAuthorityState(null)).toBeNull();
    expect(parseShellAuthorityState("connected")).toBeNull();
    expect(parseShellAuthorityState([state])).toBeNull();
    expect(parseShellAuthorityState({ ...state, endpointId: 7 })).toBeNull();
    expect(
      parseShellAuthorityState({ ...state, ownerEndpointId: 7 }),
    ).toBeNull();
    expect(parseShellAuthorityState({ ...state, generation: 1.5 })).toBeNull();
    expect(parseShellAuthorityState({ ...state, generation: "2" })).toBeNull();
    expect(parseShellAuthorityState({ ...state, role: "peer" })).toBeNull();

    for (const status of [
      "connected",
      "connecting",
      "disconnected",
      "version-mismatch",
    ]) {
      expect(parseShellAuthorityState({ ...state, status })).not.toBeNull();
    }
    expect(parseShellAuthorityState({ ...state, status: "idle" })).toBeNull();

    expect(parseShellAuthorityState({ ...state, snapshotSeq: -3 })).toBeNull();
    expect(
      parseShellAuthorityState({ ...state, snapshotSeq: Number.NaN }),
    ).toBeNull();

    const { snapshot: _snapshot, ...withoutSnapshot } = state;
    expect(parseShellAuthorityState(withoutSnapshot)).toBeNull();

    expect(parseShellAuthorityState({ ...state, forged: true })).toStrictEqual(
      state,
    );
  });

  it("rejects command requests with empty identity fields or unparsable commands", () => {
    const request = {
      generation: 1,
      commandId: "command-1",
      fromEndpointId: "shell-2",
      command: { kind: "stop" },
    };
    expect(parseShellAuthorityCommandRequest(request)).toStrictEqual(request);

    expect(parseShellAuthorityCommandRequest(null)).toBeNull();
    expect(parseShellAuthorityCommandRequest("command-1")).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({
        ...request,
        command: { kind: "teleport" },
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({ ...request, generation: -1 }),
    ).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({ ...request, generation: 2.5 }),
    ).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({ ...request, commandId: "" }),
    ).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({ ...request, commandId: 9 }),
    ).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({ ...request, fromEndpointId: "" }),
    ).toBeNull();
    expect(
      parseShellAuthorityCommandRequest({ ...request, fromEndpointId: 7 }),
    ).toBeNull();
  });

  it("bounds dictation size and transcript-session payloads", () => {
    expect(
      parseShellAuthorityDelivery({
        kind: "dictation",
        text: "z".repeat(1_000_001),
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({ kind: "composer-prefill", text: 4 }),
    ).toBeNull();
    expect(parseShellAuthorityDelivery({ kind: "unknown" })).toBeNull();
    expect(parseShellAuthorityDelivery("dictation")).toBeNull();

    const segment = {
      id: "s1",
      text: "hello",
      startMs: 0,
      endMs: 100,
      words: [],
    };
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [segment],
        startedAtMs: 1,
        audioWav: new Uint8Array([1, 2, 3]),
      }),
    ).not.toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: "s1",
        startedAtMs: 1,
        audioWav: null,
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [{ ...segment, startMs: Number.NaN }],
        startedAtMs: 1,
        audioWav: null,
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [{ ...segment, endMs: Number.POSITIVE_INFINITY }],
        startedAtMs: 1,
        audioWav: null,
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [{ ...segment, words: "[]" }],
        startedAtMs: 1,
        audioWav: null,
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [segment],
        startedAtMs: Number.POSITIVE_INFINITY,
        audioWav: null,
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: [segment],
        startedAtMs: 1,
        audioWav: "clip.wav",
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: Array.from({ length: 10_001 }, () => segment),
        startedAtMs: 1,
        audioWav: null,
      }),
    ).toBeNull();
    expect(
      parseShellAuthorityDelivery({
        kind: "transcript-session",
        segments: Array.from({ length: 10_000 }, () => segment),
        startedAtMs: 1,
        audioWav: null,
      }),
    ).not.toBeNull();
  });
});
