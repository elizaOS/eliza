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
