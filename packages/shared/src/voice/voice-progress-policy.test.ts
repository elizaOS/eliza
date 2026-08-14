import { describe, expect, it } from "vitest";
import {
  createVoiceProgressState,
  isVoiceProgressSpeechAuthorized,
  reduceVoiceProgress,
  type VoiceProgressOwner,
  type VoiceProgressState,
} from "./voice-progress-policy";

const OWNER: VoiceProgressOwner = {
  responseId: "response-1",
  taskId: "task-1",
  ownerEpoch: 1,
};

function createState(atMs = 0) {
  return createVoiceProgressState({ ...OWNER, atMs });
}

function progress(
  state: VoiceProgressState,
  atMs: number,
  overrides: Partial<{
    responseId: string;
    taskId: string;
    ownerEpoch: number;
    spokenCandidate: string;
    isSpecific: boolean;
    importance: "low" | "normal" | "high";
  }> = {},
) {
  return reduceVoiceProgress(state, {
    ...OWNER,
    type: "progress",
    atMs,
    phase: "tool",
    displayMarkdown: `Checked ${atMs} records`,
    spokenCandidate:
      "I checked the index and am comparing the remaining records.",
    isSpecific: true,
    ...overrides,
  });
}

describe("voice progress policy", () => {
  it("shows visual progress immediately but stays silent before the threshold", () => {
    const transition = progress(createState(1_000), 1_899);
    expect(transition.projection).toMatchObject({
      displayMarkdown: "Checked 1899 records",
      speechText: null,
      speechDecision: "below_threshold",
    });
    expect(transition.effects).toEqual([]);
    expect(transition.state.spokenUpdates).toBe(0);
  });

  it("rejects a late callback from a different response or task regardless of time", () => {
    const state = createState(1_000);
    for (const overrides of [
      { responseId: "old-response" },
      { taskId: "old-task" },
      { ownerEpoch: 0 },
    ]) {
      const transition = progress(state, 20_000, overrides);
      expect(transition.decision).toBe("wrong_owner");
      expect(transition.state).toBe(state);
      expect(transition.effects).toEqual([]);
    }
  });

  it("does not authorize a queued start after the same owner is rebuilt", () => {
    const oldStart = progress(createState(), 900);
    const oldSpeechId = oldStart.state.activeSpeechId as string;

    const rebuilt = createVoiceProgressState({
      ...OWNER,
      ownerEpoch: OWNER.ownerEpoch + 1,
      atMs: 1_000,
    });
    const newStart = reduceVoiceProgress(rebuilt, {
      ...OWNER,
      ownerEpoch: rebuilt.ownerEpoch,
      type: "progress",
      atMs: 1_900,
      phase: "tool",
      displayMarkdown: "Rebuilt progress",
      spokenCandidate: "I reconnected and resumed the current task.",
      isSpecific: true,
    });

    expect(newStart.state.activeSpeechId).not.toBe(oldSpeechId);
    expect(isVoiceProgressSpeechAuthorized(newStart.state, oldSpeechId)).toBe(
      false,
    );
  });

  it("requires a specific, important candidate and blocks sensitive speech", () => {
    let state = createState();
    let transition = progress(state, 900, { isSpecific: false });
    expect(transition.decision).toBe("not_specific");

    state = transition.state;
    transition = progress(state, 901, { importance: "low" });
    expect(transition.decision).toBe("low_importance");

    state = transition.state;
    transition = progress(state, 902, {
      spokenCandidate: `api_key=${"A".repeat(24)}`,
    });
    expect(transition.decision).toBe("unsafe_or_empty");
    expect(transition.projection?.speechText).toBeNull();
  });

  it("cancels exact in-flight progress speech when user speech starts", () => {
    let transition = progress(createState(), 900);
    const speechId = transition.state.activeSpeechId;
    expect(transition.effects).toEqual([
      expect.objectContaining({
        type: "progress_speech/start",
        responseId: OWNER.responseId,
        taskId: OWNER.taskId,
        speechId,
      }),
    ]);

    transition = reduceVoiceProgress(transition.state, {
      ...OWNER,
      type: "user_speech",
      active: true,
      sequence: 1,
      atMs: 901,
    });
    expect(transition.state.activeSpeechId).toBeNull();
    expect(transition.effects).toEqual([
      {
        type: "progress_speech/cancel",
        responseId: OWNER.responseId,
        taskId: OWNER.taskId,
        ownerEpoch: OWNER.ownerEpoch,
        speechId,
        reason: "user_speech",
      },
    ]);
  });

  it.each(["user_speech", "final", "cancel"] as const)(
    "%s dominates an older timestamp and tombstones a queued start",
    (type) => {
      const started = progress(createState(), 900);
      const speechId = started.state.activeSpeechId as string;
      expect(isVoiceProgressSpeechAuthorized(started.state, speechId)).toBe(
        true,
      );

      const event =
        type === "user_speech"
          ? ({
              ...OWNER,
              type,
              active: true,
              sequence: 1,
              atMs: 899,
            } as const)
          : ({ ...OWNER, type, atMs: 899 } as const);
      const revoked = reduceVoiceProgress(started.state, event);
      expect(revoked.decision).toBe(
        type === "user_speech" ? "user_speech" : "terminal",
      );
      expect(revoked.effects).toEqual([
        expect.objectContaining({
          type: "progress_speech/cancel",
          speechId,
          reason: type,
        }),
      ]);
      expect(isVoiceProgressSpeechAuthorized(revoked.state, speechId)).toBe(
        false,
      );
    },
  );

  it("suppresses speech during and for 500 ms after user speech", () => {
    let state = createState();
    state = reduceVoiceProgress(state, {
      ...OWNER,
      type: "user_speech",
      active: true,
      sequence: 1,
      atMs: 1_000,
    }).state;
    let transition = progress(state, 2_000);
    expect(transition.decision).toBe("user_speech");

    state = reduceVoiceProgress(transition.state, {
      ...OWNER,
      type: "user_speech",
      active: false,
      sequence: 1,
      atMs: 2_100,
    }).state;
    transition = progress(state, 2_599);
    expect(transition.decision).toBe("user_speech");
    transition = progress(transition.state, 2_600);
    expect(transition.decision).toBe("spoken");
  });

  it("rejects a delayed start for an already-ended speech segment", () => {
    let state = createState();
    state = reduceVoiceProgress(state, {
      ...OWNER,
      type: "user_speech",
      active: true,
      sequence: 4,
      atMs: 1_000,
    }).state;
    state = reduceVoiceProgress(state, {
      ...OWNER,
      type: "user_speech",
      active: false,
      sequence: 4,
      atMs: 1_100,
    }).state;
    const delayed = reduceVoiceProgress(state, {
      ...OWNER,
      type: "user_speech",
      active: true,
      sequence: 4,
      atMs: 2_000,
    });
    expect(delayed.decision).toBe("stale_speech_segment");
    expect(delayed.state.userSpeechActive).toBe(false);

    const next = reduceVoiceProgress(state, {
      ...OWNER,
      type: "user_speech",
      active: true,
      sequence: 5,
      atMs: 2_001,
    });
    expect(next.decision).toBe("user_speech");
    expect(next.state.userSpeechActive).toBe(true);
  });

  it("waits for exact speech settlement, then enforces interval and cap", () => {
    let transition = progress(createState(), 900);
    const firstSpeechId = transition.state.activeSpeechId as string;
    transition = progress(transition.state, 8_900);
    expect(transition.decision).toBe("speech_active");

    transition = reduceVoiceProgress(transition.state, {
      ...OWNER,
      type: "progress_speech_settled",
      atMs: 8_901,
      speechId: firstSpeechId,
    });
    transition = progress(transition.state, 8_902);
    expect(transition.decision).toBe("spoken");

    const secondSpeechId = transition.state.activeSpeechId as string;
    transition = reduceVoiceProgress(transition.state, {
      ...OWNER,
      type: "progress_speech_settled",
      atMs: 9_000,
      speechId: secondSpeechId,
    });
    transition = progress(transition.state, 20_000);
    expect(transition.decision).toBe("limit_reached");
    expect(transition.state.spokenUpdates).toBe(2);
  });

  it("accepts exact settlement even when its observed timestamp precedes a later projection", () => {
    let transition = progress(createState(), 900);
    const speechId = transition.state.activeSpeechId as string;
    transition = progress(transition.state, 1_000);
    expect(transition.decision).toBe("speech_active");

    transition = reduceVoiceProgress(transition.state, {
      ...OWNER,
      type: "progress_speech_settled",
      atMs: 950,
      speechId,
    });
    expect(transition.decision).toBe("state_updated");
    expect(transition.state.activeSpeechId).toBeNull();
    expect(transition.state.lastEventAtMs).toBe(1_000);
  });

  it("finalization revokes active speech and stale tasks cannot revive it", () => {
    let transition = progress(createState(10), 910);
    const speechId = transition.state.activeSpeechId;
    transition = reduceVoiceProgress(transition.state, {
      ...OWNER,
      type: "final",
      atMs: 920,
    });
    expect(transition.effects).toEqual([
      expect.objectContaining({
        type: "progress_speech/cancel",
        speechId,
        reason: "final",
      }),
    ]);
    expect(progress(transition.state, 921).decision).toBe("terminal");

    const fresh = createState(10);
    const stale = progress(fresh, 9);
    expect(stale.decision).toBe("stale_event");
    expect(stale.state).toBe(fresh);
  });

  it("bounds spoken progress more tightly than final answers", () => {
    const transition = progress(createState(), 900, {
      spokenCandidate: `${"Long progress update. ".repeat(20)}Finished.`,
    });
    expect(transition.projection?.speechText?.length).toBeLessThanOrEqual(160);
  });
});
