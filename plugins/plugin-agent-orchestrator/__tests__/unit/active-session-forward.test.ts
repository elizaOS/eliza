/**
 * Integration test for the MESSAGE_RECEIVED forward handler wiring: the
 * decision (deliver / queue / interrupt / ignore) → action (sendPrompt /
 * inbox / cancelSession) mapping, the (source, roomId) bind, the ACL gate, and
 * the multi-party ambient-stop + idle-interrupt fixes. The pure decider and the
 * inbox have their own unit tests; this proves they are wired correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";
import { createActiveSessionForwardHandler } from "../../src/services/active-session-forward.js";
import { SubAgentInbox } from "../../src/services/sub-agent-inbox.js";

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
    getRoom: vi.fn(async () => ({ id: "room-1" })),
    reportError: vi.fn(),
  } as never;
}

function msg(
  text: string,
  overrides: Record<string, unknown> = {},
): { message: never } {
  return {
    message: {
      entityId: "user-1",
      roomId: "room-1",
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
  metadata: { roomId: "room-1", label: "Ada" },
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
      session({ metadata: { roomId: "parent", threadRoomId: "room-1" } }),
    ]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("in-thread reply"));
    expect(acp.sendPrompt).toHaveBeenCalledWith("s1", "in-thread reply");
  });

  it("does nothing when no live session is bound to the room", async () => {
    const acp = makeAcp([session({ metadata: { roomId: "other-room" } })]);
    const handler = createActiveSessionForwardHandler(makeRuntime(acp), inbox);
    await handler(msg("nobody home"));
    expect(acp.sendPrompt).not.toHaveBeenCalled();
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
