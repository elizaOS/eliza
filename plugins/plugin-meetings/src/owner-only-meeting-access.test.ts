/**
 * Meeting transcripts, leaving a meeting and the active-meeting list (which
 * includes meeting URLs) belong to the owner, like JOIN_MEETING. Real core
 * action gate.
 */
import { canActionRun } from "@elizaos/core";
import { filterProvidersByContextGate } from "@elizaos/core/protocol";
import { describe, expect, it } from "vitest";
import { getMeetingTranscriptAction } from "./actions/get-meeting-transcript";
import { joinMeetingAction } from "./actions/join-meeting";
import { leaveMeetingAction } from "./actions/leave-meeting";
import { activeMeetingsProvider } from "./providers/active-meetings";

describe("meeting access is owner-only", () => {
  it.each([
    ["GET_MEETING_TRANSCRIPT", getMeetingTranscriptAction],
    ["LEAVE_MEETING", leaveMeetingAction],
    ["JOIN_MEETING", joinMeetingAction],
  ])("%s refuses a guest and allows the owner", (_name, gated) => {
    const run = (role: "GUEST" | "USER" | "OWNER") =>
      canActionRun(gated as never, {
        userRoles: [role],
        skipPrivateGate: true,
      });
    expect(run("GUEST")).toBe(false);
    expect(run("USER")).toBe(false);
    expect(run("OWNER")).toBe(true);
  });

  it("leaves ACTIVE_MEETINGS (meeting URLs) out of a guest's context", () => {
    const visible = (role: "GUEST" | "USER" | "OWNER") =>
      filterProvidersByContextGate([activeMeetingsProvider], undefined, [role])
        .length;
    expect(visible("GUEST")).toBe(0);
    expect(visible("USER")).toBe(0);
    expect(visible("OWNER")).toBe(1);
  });
});
