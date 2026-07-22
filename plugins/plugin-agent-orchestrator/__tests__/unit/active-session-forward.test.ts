/**
 * Integration test for the MESSAGE_RECEIVED forward handler wiring: the
 * decision (deliver / queue / interrupt / ignore) → action (sendPrompt /
 * inbox / cancelSession) mapping, the session-room bind (task/origin/thread),
 * the shared-channel classifier gate, the ACL gate, and the multi-party
 * ambient-stop + idle-interrupt fixes. The pure decider and the inbox have
 * their own unit tests; this proves they are wired correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";
import { createActiveSessionForwardHandler } from "../../src/services/active-session-forward.js";
import { SubAgentInbox } from "../../src/services/sub-agent-inbox.js";

// Room ids are UUID-validated by the binding helper, so fixtures use real
// UUID shapes. ROOM_1 is the user's origin connector channel.
const ROOM_1 = "aaaa1111-1111-4111-8111-111111111111";
const TASK_ROOM = "bbbb2222-2222-4222-8222-222222222222";
const TASK_ROOM_2 = "cccc3333-3333-4333-8333-333333333333";
const OTHER_ROOM = "dddd4444-4444-4444-8444-444444444444";
const PARENT_ROOM = "eeee5555-5555-4555-8555-555555555555";

type Session = {
  id: string;
  name: string;
  agentType: string;
  status: string;
  metadata: Record<string, unknown>;
};

function makeAcp(sessions: Session[]) {
  return {
    serviceType: AcpService.serviceType,
    listSessions: vi.fn(() => sessions),
    sendPrompt: vi.fn(async () => undefined),
    cancelSession: vi.fn(async () => undefined),
  };
}

function makeRuntime(
  acp: ReturnType<typeof makeAcp>,
  settings: Record<string, string | undefined> = {
    // Default policy gates `interact` behind ADMIN; relax to GUEST so the ACL
    // allows in tests (ACL denial is covered by its own case + task-policy).
    TASK_AGENT_ROLE_POLICY: JSON.stringify({ default: "GUEST" }),
  },
  useModel?: ReturnType<typeof vi.fn>,
) {
  return {
    agentId: "agent-self",
    getService: vi.fn((type: string) =>
      type === AcpService.serviceType ? acp : undefined,
    ),
    getSetting: vi.fn((k: string) => settings[k]),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // The ACL (`requireTaskAgentAccess` → `resolveConnectorSource`) reads the
    // room's connector source; a source-less room is genuine client-chat, which
    // the default GUEST policy above permits. Without `getRoom` the lookup throws
    // and fails closed (SOURCE_RESOLUTION_FAILED → denied), so every delivery
    // case would wrongly drop. `reportError` backs the fail-closed path.
    getRoom: vi.fn(async () => ({ id: ROOM_1 })),
    reportError: vi.fn(),
    ...(useModel ? { useModel } : {}),
  } as never;
}

function msg(
  text: string,
  overrides: Record<string, unknown> = {},
): { message: never } {
  return {
    message: {
      entityId: "user-1",
      roomId: ROOM_1,
      content: { text },
      ...overrides,
    } as never,
  };
}

let inbox: SubAgentInbox;
beforeEach(() => {
  inbox = new SubAgentInbox();
});
afterEach(() => {
  inbox.clearAll();
  vi.clearAllMocks();
});

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  name: "Ada",
  agentType: "claude",
  status: "ready",
  metadata: { roomId: ROOM_1, label: "Ada" },
  ...over,
});

describe("active-session forward handler", () => {
  it("delivers a message to an idle bound session", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("add a test for the parser"));
    expect(acp.sendPrompt).toHaveBeenCalledWith(
      "s1",
      "add a test for the parser",
    );
    expect(acp.cancelSession).not.toHaveBeenCalled();
  });

  it("queues a message while the session is mid-turn (tool_running)", async () => {
    const acp = makeAcp([session({ status: "tool_running" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("also add logging"));
    expect(acp.sendPrompt).not.toHaveBeenCalled();
    expect(inbox.size("s1")).toBe(1);
    // The queued text drains on the next idle delivery.
    expect(inbox.drain("s1")).toBe("also add logging");
  });

  it("interrupts (cancels) a busy session on an addressed stop", async () => {
    const acp = makeAcp([session({ status: "tool_running" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    inbox.enqueue("s1", "earlier queued");
    await handler(msg("Ada, stop"));
    expect(acp.cancelSession).toHaveBeenCalledWith("s1");
    expect(acp.sendPrompt).not.toHaveBeenCalled();
    expect(inbox.size("s1")).toBe(0); // inbox cleared on interrupt
  });

  it("does NOT cancel on an unaddressed ambient stop in a multi-party room", async () => {
    const acp = makeAcp([
      session({ id: "s1", status: "tool_running" }),
      session({ id: "s2", name: "Bob", status: "tool_running" }),
    ]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("stop"));
    expect(acp.cancelSession).not.toHaveBeenCalled();
    expect(acp.sendPrompt).not.toHaveBeenCalled();
  });

  it("delivers (does not drop) an interrupt-class message to an idle agent", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("stop"));
    expect(acp.sendPrompt).toHaveBeenCalledWith("s1", "stop");
    expect(acp.cancelSession).not.toHaveBeenCalled();
  });

  it("flushes queued text together with the new message on idle delivery", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    inbox.enqueue("s1", "queued-1");
    await handler(msg("now-2"));
    expect(acp.sendPrompt).toHaveBeenCalledWith("s1", "queued-1\nnow-2");
    expect(inbox.size("s1")).toBe(0);
  });

  it("requeues the message if sendPrompt throws (never silently dropped)", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    acp.sendPrompt.mockRejectedValueOnce(new Error("raced back to busy"));
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("deliver-me"));
    expect(inbox.size("s1")).toBe(1);
    expect(inbox.drain("s1")).toBe("deliver-me");
  });

  it("ignores internal sub-agent narration (echo-loop guard)", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(
      msg("sub agent status", { content: { text: "x", source: "sub_agent" } }),
    );
    expect(acp.sendPrompt).not.toHaveBeenCalled();
  });

  it("ignores transient status posts", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("progress", { metadata: { transient: true } }));
    expect(acp.sendPrompt).not.toHaveBeenCalled();
  });

  it("ignores the agent's own messages", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("self post", { entityId: "agent-self" }));
    expect(acp.sendPrompt).not.toHaveBeenCalled();
  });

  it("matches a session by threadRoomId, not just roomId", async () => {
    const acp = makeAcp([
      session({ metadata: { roomId: PARENT_ROOM, threadRoomId: ROOM_1 } }),
    ]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("in-thread reply"));
    expect(acp.sendPrompt).toHaveBeenCalledWith("s1", "in-thread reply");
  });

  it("does nothing when no live session is bound to the room", async () => {
    const acp = makeAcp([session({ metadata: { roomId: OTHER_ROOM } })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("nobody home"));
    expect(acp.sendPrompt).not.toHaveBeenCalled();
  });

  it("forwards an origin-channel follow-up when meta.roomId is a minted task room", async () => {
    // Default-on task rooms: spawn stamps meta.roomId = taskRoomId while the
    // user keeps typing in the origin connector channel (originRoomId). No
    // model on this runtime → the shared-channel classifier falls open to the
    // regex baseline (deliver when idle) so follow-ups still flow.
    const acp = makeAcp([
      session({
        metadata: {
          roomId: TASK_ROOM,
          taskRoomId: TASK_ROOM,
          originRoomId: ROOM_1,
          label: "Ada",
        },
      }),
    ]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("also handle the edge case"));
    expect(acp.sendPrompt).toHaveBeenCalledWith(
      "s1",
      "also handle the edge case",
    );
  });

  it("matches a session by sourceRoomId as an origin binding", async () => {
    const acp = makeAcp([
      session({
        metadata: {
          roomId: TASK_ROOM,
          taskRoomId: TASK_ROOM,
          sourceRoomId: ROOM_1,
          label: "Ada",
        },
      }),
    ]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("use bun, not npm"));
    expect(acp.sendPrompt).toHaveBeenCalledWith("s1", "use bun, not npm");
  });

  it("consults the classifier on a shared channel and honors an ignore verdict (planner-owned message)", async () => {
    // The origin channel is shared with the orchestrator planner. An idle solo
    // session must NOT blanket-receive planner-directed messages ("set a
    // reminder") — that is cross-task prompt injection. The classifier says
    // ignore → nothing is forwarded.
    const acp = makeAcp([
      session({
        metadata: {
          roomId: TASK_ROOM,
          taskRoomId: TASK_ROOM,
          originRoomId: ROOM_1,
          label: "Ada",
        },
      }),
    ]);
    const useModel = vi.fn(async () =>
      JSON.stringify({ action: "ignore", reason: "planner command" }),
    );
    const handler = createActiveSessionForwardHandler(
      makeRuntime(acp, undefined, useModel),
      inbox,
    );
    await handler(msg("set a reminder for 6pm"));
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(acp.sendPrompt).not.toHaveBeenCalled();
    expect(inbox.size("s1")).toBe(0);
  });

  it("delivers on a shared channel when the classifier judges the message a task follow-up", async () => {
    const acp = makeAcp([
      session({
        metadata: {
          roomId: TASK_ROOM,
          taskRoomId: TASK_ROOM,
          originRoomId: ROOM_1,
          label: "Ada",
        },
      }),
    ]);
    const useModel = vi.fn(async () =>
      JSON.stringify({ action: "deliver", reason: "task follow-up" }),
    );
    const handler = createActiveSessionForwardHandler(
      makeRuntime(acp, undefined, useModel),
      inbox,
    );
    await handler(msg("also cover the empty-input case"));
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(acp.sendPrompt).toHaveBeenCalledWith(
      "s1",
      "also cover the empty-input case",
    );
  });

  it("keeps the idle fast-path (no classifier call) for a dedicated task-room binding", async () => {
    const acp = makeAcp([
      session({
        metadata: {
          roomId: TASK_ROOM,
          taskRoomId: TASK_ROOM,
          originRoomId: ROOM_1,
          label: "Ada",
        },
      }),
    ]);
    const useModel = vi.fn(async () =>
      JSON.stringify({ action: "ignore", reason: "should not be consulted" }),
    );
    const handler = createActiveSessionForwardHandler(
      makeRuntime(acp, undefined, useModel),
      inbox,
    );
    // Message posted IN the dedicated task room — unambiguously for this task.
    await handler(msg("tighten the types", { roomId: TASK_ROOM }));
    expect(useModel).not.toHaveBeenCalled();
    expect(acp.sendPrompt).toHaveBeenCalledWith("s1", "tighten the types");
  });

  it("falls open to delivery when the shared-channel classifier errors", async () => {
    // Fail-open is deliberate: fail-closed would silently resurrect the
    // dropped-follow-ups bug on every model-less runtime.
    const acp = makeAcp([
      session({
        metadata: {
          roomId: TASK_ROOM,
          taskRoomId: TASK_ROOM,
          originRoomId: ROOM_1,
          label: "Ada",
        },
      }),
    ]);
    const useModel = vi.fn(async () => {
      throw new Error("model offline");
    });
    const handler = createActiveSessionForwardHandler(
      makeRuntime(acp, undefined, useModel),
      inbox,
    );
    await handler(msg("ship it with the fix"));
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(acp.sendPrompt).toHaveBeenCalledWith("s1", "ship it with the fix");
  });

  it("broadcasts an addressed follow-up to ALL bound live sessions, not just the first", async () => {
    const acp = makeAcp([
      session({ id: "s1", status: "ready" }),
      session({
        id: "s2",
        name: "Bob",
        status: "ready",
        metadata: {
          roomId: TASK_ROOM_2,
          taskRoomId: TASK_ROOM_2,
          originRoomId: ROOM_1,
          label: "Bob",
        },
      }),
    ]);
    // s2 binds via the shared origin channel → classifier consulted; verdict
    // deliver (the message addresses Bob and the task).
    const useModel = vi.fn(async () =>
      JSON.stringify({ action: "deliver", reason: "addressed follow-up" }),
    );
    const handler = createActiveSessionForwardHandler(
      makeRuntime(acp, undefined, useModel),
      inbox,
    );
    await handler(msg("Ada and Bob, please add tests"));
    expect(acp.sendPrompt).toHaveBeenCalledTimes(2);
    expect(acp.sendPrompt).toHaveBeenCalledWith(
      "s1",
      "Ada and Bob, please add tests",
    );
    expect(acp.sendPrompt).toHaveBeenCalledWith(
      "s2",
      "Ada and Bob, please add tests",
    );
  });

  it("decides per session in a broadcast: idle session delivered, busy session queued", async () => {
    const acp = makeAcp([
      session({ id: "s1", status: "ready" }),
      session({
        id: "s2",
        name: "Bob",
        status: "tool_running",
        metadata: { roomId: ROOM_1, label: "Bob" },
      }),
    ]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("Ada and Bob, please add tests"));
    expect(acp.sendPrompt).toHaveBeenCalledTimes(1);
    expect(acp.sendPrompt).toHaveBeenCalledWith(
      "s1",
      "Ada and Bob, please add tests",
    );
    expect(inbox.size("s2")).toBe(1);
    expect(inbox.drain("s2")).toBe("Ada and Bob, please add tests");
  });

  it("blocks forwarding when the ACL denies interact", async () => {
    const acp = makeAcp([session({ status: "ready" })]);
    // ADMIN-gated interact + a sender that resolves to no elevated role.
    const runtime = makeRuntime(acp, {
      TASK_AGENT_ROLE_POLICY: JSON.stringify({ default: "ADMIN" }),
    });
    const handler = createActiveSessionForwardHandler(runtime, inbox);
    await handler(msg("inject into someone else's agent"));
    expect(acp.sendPrompt).not.toHaveBeenCalled();
  });
});
