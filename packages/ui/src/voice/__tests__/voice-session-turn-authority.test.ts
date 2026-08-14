import type { ResponseId } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { VoiceSessionTurnAuthority } from "../voice-session-turn-authority";

function committedResponse(
  authority: VoiceSessionTurnAuthority,
  traceId = "trace-a",
): ResponseId {
  authority.openSession("session-a", 0);
  expect(authority.acceptPartialTranscript("hello", 1).accepted).toBe(true);
  expect(authority.commitTranscript("hello", traceId, 2).accepted).toBe(true);
  return authority.state?.response?.id as ResponseId;
}

describe("VoiceSessionTurnAuthority", () => {
  it("owns monotonic turn/response identity and rejects old response control", () => {
    const authority = new VoiceSessionTurnAuthority();
    const first = committedResponse(authority);
    expect(authority.acceptModelStarted("trace-a", 3).accepted).toBe(true);
    expect(authority.acceptSpeakingStarted("trace-a", 4).accepted).toBe(true);

    const interrupted = authority.acceptInterrupted("trace-a", "acoustic", 5);
    expect(interrupted.accepted).toBe(true);
    expect(authority.state?.response).toBeNull();
    expect(authority.acceptPartialTranscript("actually", 6).accepted).toBe(
      true,
    );
    expect(
      authority.commitTranscript("actually continue", "trace-b", 7).accepted,
    ).toBe(true);
    const second = authority.state?.response?.id as ResponseId;

    expect(second).not.toBe(first);
    expect(authority.acceptSpeakingStarted("trace-b", 8).accepted).toBe(true);
    expect(authority.acceptSpeakingEnded("trace-a", 9)).toMatchObject({
      accepted: false,
      rejection: "stale_response",
    });
    expect(authority.acceptTurnEnded("trace-a", "spoken", 10)).toMatchObject({
      accepted: false,
      rejection: "stale_response",
    });
    expect(authority.state?.response?.id).toBe(second);
    expect(authority.state?.response?.status).toBe("speaking");
  });

  it("rejects stale prior-response audio and exact older playback drains", () => {
    const authority = new VoiceSessionTurnAuthority();
    const first = committedResponse(authority);
    authority.acceptSpeakingStarted("trace-a", 3);
    const firstAudio = authority.authorizeAudioFrame();
    expect(firstAudio?.responseId).toBe(first);
    expect(
      authority.acceptPlaybackEnqueued(firstAudio as never, 11, 4).accepted,
    ).toBe(true);

    authority.acceptInterrupted("trace-a", "acoustic", 5);
    authority.acceptPartialTranscript("next", 6);
    authority.commitTranscript("next", "trace-b", 7);
    authority.acceptSpeakingStarted("trace-b", 8);
    const secondAudio = authority.authorizeAudioFrame();
    expect(secondAudio?.responseId).not.toBe(first);

    expect(authority.isResponseLeaseCurrent(firstAudio)).toBe(false);
    expect(
      authority.acceptPlaybackEnqueued(firstAudio as never, 12, 9),
    ).toMatchObject({ accepted: false, rejection: "stale_response" });
    expect(
      authority.acceptPlaybackEnqueued(secondAudio as never, 13, 10).accepted,
    ).toBe(true);
    expect(authority.acceptPlaybackDrained(11, 11)).toMatchObject({
      accepted: false,
      rejection: "stale_playback",
    });
    expect(authority.playbackResponseId).toBe(secondAudio?.responseId);
    expect(authority.acceptPlaybackDrained(13, 12).accepted).toBe(true);
    expect(authority.playbackResponseId).toBeNull();
  });

  it("makes a late provisional timer harmless after confirmed barge-in", () => {
    const authority = new VoiceSessionTurnAuthority();
    committedResponse(authority);
    authority.acceptSpeakingStarted("trace-a", 3);
    const audio = authority.authorizeAudioFrame();
    authority.acceptPlaybackEnqueued(audio as never, 1, 4);
    const provisional = authority.beginProvisionalSpeech(5);
    const attemptId = authority.speechAttemptId;

    expect(provisional.effects[0]).toMatchObject({ type: "playback/pause" });
    expect(attemptId).not.toBeNull();
    expect(authority.acceptInterrupted("trace-a", "acoustic", 6).accepted).toBe(
      true,
    );
    expect(
      authority.rejectProvisionalSpeech(attemptId as never, 355, "timer"),
    ).toMatchObject({ accepted: false, rejection: "stale_speech_attempt" });
    expect(authority.state?.speechAttempt).toBeNull();
    expect(authority.state?.response).toBeNull();
  });

  it("resumes the exact retained response after a false provisional cutoff", () => {
    const authority = new VoiceSessionTurnAuthority();
    const responseId = committedResponse(authority);
    authority.acceptSpeakingStarted("trace-a", 3);
    const audio = authority.authorizeAudioFrame();
    authority.acceptPlaybackEnqueued(audio as never, 7, 4);
    authority.beginProvisionalSpeech(5);
    const attemptId = authority.speechAttemptId;
    const rejected = authority.rejectProvisionalSpeech(
      attemptId as never,
      6,
      "detector",
    );

    expect(rejected.accepted).toBe(true);
    expect(rejected.effects).toContainEqual({
      type: "playback/resume",
      responseId,
    });
    expect(authority.state?.response?.id).toBe(responseId);
  });

  it("invalidates session leases and callbacks across reconnect/reset", () => {
    const authority = new VoiceSessionTurnAuthority();
    committedResponse(authority);
    authority.acceptSpeakingStarted("trace-a", 3);
    const oldSession = authority.currentSessionLease();
    const oldAudio = authority.authorizeAudioFrame();
    authority.acceptPlaybackEnqueued(oldAudio as never, 1, 4);
    const reconnecting = authority.enterReconnecting(5);

    expect(reconnecting.accepted).toBe(true);
    expect(reconnecting.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "playback/flush" }),
        expect.objectContaining({ type: "model/abort" }),
      ]),
    );
    authority.openSession("session-b", 6);
    expect(authority.isSessionLeaseCurrent(oldSession)).toBe(false);
    expect(authority.isResponseLeaseCurrent(oldAudio)).toBe(false);
    expect(authority.acceptPlaybackDrained(1, 7)).toMatchObject({
      accepted: false,
      rejection: "stale_playback",
    });
    expect(authority.isReadySession("session-a")).toBe(false);
    expect(authority.isReadySession("session-b")).toBe(true);
  });

  it("authorizes a transition effect only at its exact published revision", () => {
    const authority = new VoiceSessionTurnAuthority();
    const responseId = committedResponse(authority);
    authority.acceptSpeakingStarted("trace-a", 3);
    const audio = authority.authorizeAudioFrame();
    authority.acceptPlaybackEnqueued(audio as never, 3, 4);
    const provisional = authority.beginProvisionalSpeech(5);
    expect(authority.isPlaybackEffectAuthorized(provisional, responseId)).toBe(
      true,
    );

    authority.rejectProvisionalSpeech(
      authority.speechAttemptId as never,
      6,
      "detector",
    );
    expect(authority.isPlaybackEffectAuthorized(provisional, responseId)).toBe(
      false,
    );
  });
});
