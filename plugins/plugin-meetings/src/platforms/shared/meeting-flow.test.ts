import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { MeetingEndReason } from "@elizaos/shared";
import type { MeetingBotSession, MeetingSessionStatus } from "../../types.js";
import { runMeetingFlow } from "./meeting-flow.js";
import type { AdmissionOutcome, PlatformStrategies } from "./strategy.js";

/** Minimal session; page is opaque to the flow (only forwarded to strategies). */
function makeSession(controller = new AbortController()): {
  session: MeetingBotSession;
  statuses: MeetingSessionStatus[];
} {
  const statuses: MeetingSessionStatus[] = [];
  const session = {
    id: "00000000-0000-0000-0000-000000000000",
    config: {
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      nativeMeetingId: "abc-defg-hij",
      botName: "Bot",
      autoLeave: {
        waitingRoomTimeoutMs: 1000,
        noOneJoinedTimeoutMs: 1000,
        everyoneLeftTimeoutMs: 1000,
      },
      retainAudio: true,
    },
    sink: {
      pushSpeakerAudio: vi.fn(),
      setSpeakerName: vi.fn(),
      flushSpeaker: vi.fn(),
      participantJoined: vi.fn(),
      participantLeft: vi.fn(),
    },
    signal: controller.signal,
    reportStatus: (s: MeetingSessionStatus) => statuses.push(s),
  } as unknown as MeetingBotSession;
  return { session, statuses };
}

function baseStrategies(overrides: Partial<PlatformStrategies> = {}): PlatformStrategies {
  return {
    join: vi.fn(async () => {}),
    waitForAdmission: vi.fn(async (): Promise<AdmissionOutcome> => "admitted"),
    checkAdmissionSilent: vi.fn(async () => true),
    prepare: vi.fn(async () => {}),
    startRecording: vi.fn(async (): Promise<MeetingEndReason> => "normal_completion"),
    startRemovalMonitor: vi.fn(() => new Promise<MeetingEndReason>(() => {})),
    leave: vi.fn(async () => {}),
    ...overrides,
  };
}

const page = {} as Page;

describe("runMeetingFlow", () => {
  it("happy path: join → admitted → record → leave, statuses in order", async () => {
    const { session, statuses } = makeSession();
    const strategies = baseStrategies();
    const reason = await runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    expect(reason).toBe("normal_completion");
    expect(statuses).toEqual(["joining", "awaiting_admission", "active", "leaving"]);
    expect(strategies.leave).toHaveBeenCalledOnce();
  });

  it("maps a join throw to join_failed without leaving mid-air", async () => {
    const { session } = makeSession();
    const strategies = baseStrategies({
      join: vi.fn(async () => {
        throw new Error("navigation failed");
      }),
    });
    const reason = await runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    expect(reason).toBe("join_failed");
    expect(strategies.startRecording).not.toHaveBeenCalled();
  });

  it("rejected admission returns admission_rejected (no leave click needed)", async () => {
    const { session } = makeSession();
    const strategies = baseStrategies({
      waitForAdmission: vi.fn(async (): Promise<AdmissionOutcome> => "rejected"),
    });
    const reason = await runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    expect(reason).toBe("admission_rejected");
    expect(strategies.startRecording).not.toHaveBeenCalled();
  });

  it("timeout admission leaves and returns admission_timeout", async () => {
    const { session } = makeSession();
    const strategies = baseStrategies({
      waitForAdmission: vi.fn(async (): Promise<AdmissionOutcome> => "timeout"),
    });
    const reason = await runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    expect(reason).toBe("admission_timeout");
    expect(strategies.leave).toHaveBeenCalledOnce();
  });

  it("false-positive admission (silent check fails) returns join_failed", async () => {
    const { session } = makeSession();
    const strategies = baseStrategies({
      checkAdmissionSilent: vi.fn(async () => false),
    });
    const reason = await runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    expect(reason).toBe("join_failed");
  });

  it("removal monitor winning the race returns removed_by_admin", async () => {
    const { session } = makeSession();
    const strategies = baseStrategies({
      startRecording: vi.fn(() => new Promise<MeetingEndReason>(() => {})),
      startRemovalMonitor: vi.fn(async (): Promise<MeetingEndReason> => "removed_by_admin"),
    });
    const reason = await runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    expect(reason).toBe("removed_by_admin");
  });

  it("user abort during active phase returns requested_stop and aborts racers", async () => {
    const controller = new AbortController();
    const { session } = makeSession(controller);
    let recordingSignal: AbortSignal | undefined;
    const strategies = baseStrategies({
      startRecording: vi.fn((_p, s: MeetingBotSession) => {
        recordingSignal = s.signal;
        return new Promise<MeetingEndReason>(() => {});
      }),
    });
    const flow = runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    // Let the flow reach the active race, then abort.
    await new Promise((r) => setTimeout(r, 1050));
    controller.abort();
    const reason = await flow;
    expect(reason).toBe("requested_stop");
    expect(recordingSignal?.aborted).toBe(true);
  });

  it("aborts racers after normal completion so monitors stop polling", async () => {
    const { session } = makeSession();
    let removalSignal: AbortSignal | undefined;
    const strategies = baseStrategies({
      startRemovalMonitor: vi.fn((_p, s: MeetingBotSession) => {
        removalSignal = s.signal;
        return new Promise<MeetingEndReason>(() => {});
      }),
    });
    const reason = await runMeetingFlow({ page, session, strategies, waitingRoomTimeoutMs: 1000 });
    expect(reason).toBe("normal_completion");
    expect(removalSignal?.aborted).toBe(true);
  });
});
