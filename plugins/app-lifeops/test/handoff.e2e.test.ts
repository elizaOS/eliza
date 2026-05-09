// @journey-14
/**
 * J14 — Group chat handoff e2e (closes `JOURNEY_GAME_THROUGH §J13`).
 *
 * Pattern under test:
 *   1. Three-party room. Agent in mid-conversation.
 *   2. Agent enters handoff via `MESSAGE.handoff` verb=enter
 *      (resumeOn=mention).
 *   3. RoomPolicyProvider sees `HandoffStore.status(roomId).active === true`
 *      and injects "this room is in handoff mode — do not respond unless
 *      you are @-mentioned" into context.
 *   4. Other humans reply; the planner sees the directive and stays quiet.
 *   5. The user @-mentions the agent → `evaluateResume` returns
 *      `shouldResume: true`; verb=resume clears the handoff.
 *
 * This is unit/integration shape — no LLM in the loop. We assert the
 * contract: enter → status active → resume detection per condition →
 * exit → status inactive.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { messageHandoffAction } from "../src/actions/message-handoff.ts";
import {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  type ResumeCondition,
} from "../src/lifeops/handoff/store.ts";
import { roomPolicyProvider } from "../src/providers/room-policy.ts";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";

const STATE: State = { values: {}, data: {}, text: "" };

function makeMessage(
  runtime: IAgentRuntime,
  roomId: string,
  text: string,
): Memory {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}` as Memory["id"],
    entityId: runtime.agentId,
    roomId: roomId as Memory["roomId"],
    agentId: runtime.agentId,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

describe("J14 — group chat handoff e2e (closes J13)", () => {
  it("enter sets status.active; provider injects stay-quiet directive", async () => {
    const runtime = createMinimalRuntimeStub();
    const roomId = "three-party-room-1";

    // Pre-handoff: provider quiet.
    const before = await roomPolicyProvider.get(
      runtime,
      makeMessage(runtime, roomId, "let me check with the others"),
      STATE,
    );
    expect(before.values?.roomInHandoff).toBe(false);
    expect(before.text).toBe("");

    // Agent enters handoff (resumeOn=mention by default).
    const enterCallback: { lastText?: string; lastData?: unknown } = {};
    const enterResult = await messageHandoffAction.handler?.(
      runtime,
      makeMessage(runtime, roomId, "I'll let you take it from here."),
      undefined,
      {
        parameters: {
          verb: "enter",
          reason: "agent stepping back",
          resumeKind: "mention",
        },
      },
      async (p: { text?: string; data?: unknown }) => {
        enterCallback.lastText = p.text;
        enterCallback.lastData = p.data;
        return [];
      },
      [],
    );
    expect(enterResult?.success).toBe(true);
    expect(enterCallback.lastText).toMatch(/Stepping back/);

    const store = createHandoffStore(runtime);
    const status = await store.status(roomId);
    expect(status.active).toBe(true);
    expect(status.resumeOn?.kind).toBe("mention");
    expect(status.reason).toBe("agent stepping back");

    // Provider now surfaces the directive.
    const after = await roomPolicyProvider.get(
      runtime,
      makeMessage(runtime, roomId, "another human replies"),
      STATE,
    );
    expect(after.values?.roomInHandoff).toBe(true);
    expect(after.text).toMatch(/handoff mode/i);
    expect(after.text).toMatch(/@-mentioned/);
  });

  it("@mention satisfies resumeOn.mention; resume clears handoff", async () => {
    const runtime = createMinimalRuntimeStub();
    const roomId = "three-party-room-2";

    // Enter with resumeOn = mention.
    await messageHandoffAction.handler?.(
      runtime,
      makeMessage(runtime, roomId, "I'll let you take it from here."),
      undefined,
      {
        parameters: { verb: "enter", reason: "step back", resumeKind: "mention" },
      },
      async () => [],
      [],
    );

    const store = createHandoffStore(runtime);
    const active = await store.status(roomId);
    expect(active.active).toBe(true);

    // Other human reply → no @mention → does NOT resume.
    const otherHumanInbound = evaluateResume({
      status: active,
      mentionsAgent: false,
    });
    expect(otherHumanInbound.shouldResume).toBe(false);

    // User @-mentions agent → DOES resume.
    const mention = evaluateResume({
      status: active,
      mentionsAgent: true,
    });
    expect(mention.shouldResume).toBe(true);
    expect(mention.reason).toMatch(/mentioned/);

    // verb=resume exits handoff.
    const resumeResult = await messageHandoffAction.handler?.(
      runtime,
      makeMessage(runtime, roomId, "agent come back"),
      undefined,
      { parameters: { verb: "resume" } },
      async () => [],
      [],
    );
    expect(resumeResult?.success).toBe(true);
    const exited = await store.status(roomId);
    expect(exited.active).toBe(false);
  });

  it("evaluateResume — silence_minutes only fires after threshold", () => {
    const cond: ResumeCondition = { kind: "silence_minutes", minutes: 30 };
    const status = {
      active: true,
      enteredAt: "2026-05-09T12:00:00.000Z",
      reason: "step back",
      resumeOn: cond,
    };

    // 10 minutes silence — too soon.
    const tooSoon = evaluateResume({
      status,
      lastMessageIso: "2026-05-09T12:30:00.000Z",
      nowIso: "2026-05-09T12:40:00.000Z",
    });
    expect(tooSoon.shouldResume).toBe(false);

    // 35 minutes silence — over threshold.
    const overThreshold = evaluateResume({
      status,
      lastMessageIso: "2026-05-09T12:00:00.000Z",
      nowIso: "2026-05-09T12:35:00.000Z",
    });
    expect(overThreshold.shouldResume).toBe(true);
    expect(overThreshold.reason).toMatch(/silence/);
  });

  it("evaluateResume — user_request_help only fires for that user", () => {
    const cond: ResumeCondition = {
      kind: "user_request_help",
      userId: "user-alice",
    };
    const status = {
      active: true,
      enteredAt: "2026-05-09T12:00:00.000Z",
      reason: "step back",
      resumeOn: cond,
    };

    const wrongUser = evaluateResume({
      status,
      requestingUserId: "user-bob",
      userRequestedHelp: true,
    });
    expect(wrongUser.shouldResume).toBe(false);

    const wrongIntent = evaluateResume({
      status,
      requestingUserId: "user-alice",
      userRequestedHelp: false,
    });
    expect(wrongIntent.shouldResume).toBe(false);

    const match = evaluateResume({
      status,
      requestingUserId: "user-alice",
      userRequestedHelp: true,
    });
    expect(match.shouldResume).toBe(true);
  });

  it("evaluateResume — explicit_resume never auto-fires (out-of-band only)", () => {
    const cond: ResumeCondition = { kind: "explicit_resume" };
    const status = {
      active: true,
      enteredAt: "2026-05-09T12:00:00.000Z",
      reason: "step back",
      resumeOn: cond,
    };
    // Even @mention does not auto-resume; only the verb=resume call does.
    const mention = evaluateResume({ status, mentionsAgent: true });
    expect(mention.shouldResume).toBe(false);
  });

  it("describeResumeCondition produces a planner-readable phrase", () => {
    expect(describeResumeCondition({ kind: "mention" })).toMatch(
      /@-mentioned/,
    );
    expect(describeResumeCondition({ kind: "explicit_resume" })).toMatch(
      /explicitly/,
    );
    expect(
      describeResumeCondition({ kind: "silence_minutes", minutes: 5 }),
    ).toMatch(/5 minutes/);
    expect(
      describeResumeCondition({
        kind: "user_request_help",
        userId: "user-alice",
      }),
    ).toMatch(/user-alice/);
  });

  it("MESSAGE.handoff verb=status reports current state", async () => {
    const runtime = createMinimalRuntimeStub();
    const roomId = "three-party-room-3";
    const captured: { text?: string; data?: unknown } = {};
    const cb = async (p: { text?: string; data?: unknown }) => {
      captured.text = p.text;
      captured.data = p.data;
      return [];
    };

    // status before any enter → inactive.
    await messageHandoffAction.handler?.(
      runtime,
      makeMessage(runtime, roomId, "what's the room state?"),
      undefined,
      { parameters: { verb: "status" } },
      cb,
      [],
    );
    expect(captured.text).toMatch(/No handoff active/);

    // enter → status reports active.
    await messageHandoffAction.handler?.(
      runtime,
      makeMessage(runtime, roomId, "stepping back"),
      undefined,
      {
        parameters: { verb: "enter", reason: "step", resumeKind: "mention" },
      },
      cb,
      [],
    );
    await messageHandoffAction.handler?.(
      runtime,
      makeMessage(runtime, roomId, "still active?"),
      undefined,
      { parameters: { verb: "status" } },
      cb,
      [],
    );
    expect(captured.text).toMatch(/Handoff active/);
  });

  it("multiple rooms can be in handoff simultaneously", async () => {
    const runtime = createMinimalRuntimeStub();
    const store = createHandoffStore(runtime);
    await store.enter("room-A", {
      reason: "step A",
      resumeOn: { kind: "mention" },
    });
    await store.enter("room-B", {
      reason: "step B",
      resumeOn: { kind: "silence_minutes", minutes: 15 },
    });

    const a = await store.status("room-A");
    const b = await store.status("room-B");
    expect(a.active).toBe(true);
    expect(b.active).toBe(true);
    expect(a.resumeOn?.kind).toBe("mention");
    expect(b.resumeOn?.kind).toBe("silence_minutes");

    await store.exit("room-A");
    expect((await store.status("room-A")).active).toBe(false);
    // room-B still active.
    expect((await store.status("room-B")).active).toBe(true);
  });
});
