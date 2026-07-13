/**
 * orchestrator-follow-up-forwarding — deterministic, keyless evidence that a
 * user follow-up posted into a task's origin room mid-task reaches the RUNNING
 * sub-agent session bound to that room.
 *
 * Drives the REAL `createActiveSessionForwardHandler` (the production
 * MESSAGE_RECEIVED listener) and the REAL `SubAgentInbox` + interruption
 * decider over a scripted ACP boundary that records `sendPrompt` deliveries —
 * only the subprocess seam is scripted, exactly as the grilling harness does.
 * Covers both delivery modes: an idle (ready) session receives the follow-up
 * immediately, and a busy (tool_running) session has it queued in the inbox
 * for the flush listener.
 */
import type { Action, IAgentRuntime, Memory, Plugin } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { createActiveSessionForwardHandler } from "../../src/services/active-session-forward.js";
import { SubAgentInbox } from "../../src/services/sub-agent-inbox.js";

const PLUGIN_NAME = "orchestrator-follow-up-forwarding-scenario";
const ACTION_NAME = "ORCHESTRATOR_FOLLOW_UP_FORWARDING";

const AGENT_ID = "00000000-0000-4000-8000-0000f0f0f0f0";
const USER_ID = "99999999-9999-4999-8999-999999999999";
const ORIGIN_ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OTHER_ROOM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const READY_SESSION = "forward-ready-1";
const BUSY_SESSION = "forward-busy-1";
const BUSY_ROOM = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const FOLLOW_UP = "Please rename the button label to 'Shuffle color'";
const BUSY_FOLLOW_UP = "After this step, run the accessibility audit";

type ForwardScenarioResult = {
  summary: string;
  deliveredToReady: Array<{ sessionId: string; text: string }>;
  queuedForBusy: string | null;
  unrelatedRoomDeliveries: number;
};

function forwardScenarioData(
  ctx: ScenarioContext,
): ForwardScenarioResult | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ACTION_NAME,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as ForwardScenarioResult)
    : null;
}

function makeSession(
  id: string,
  roomId: string,
  status: string,
): Record<string, unknown> {
  return {
    id,
    name: id,
    agentType: "codex",
    workdir: "/tmp/forwarding-scenario",
    status,
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: { roomId, label: "Ada", task: "build the color app" },
  };
}

function userMessage(roomId: string, text: string): Memory {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
    roomId,
    entityId: USER_ID,
    content: { text, source: "client_chat", metadata: {} },
  } as unknown as Memory;
}

async function runForwardingCheck(): Promise<ForwardScenarioResult> {
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const sessions = [
    makeSession(READY_SESSION, ORIGIN_ROOM, "ready"),
    makeSession(BUSY_SESSION, BUSY_ROOM, "tool_running"),
  ];
  const acp = {
    listSessions: () => sessions,
    sendPrompt: async (sessionId: string, text: string) => {
      delivered.push({ sessionId, text });
      return { stopReason: "end_turn", finalText: "ok" };
    },
  };
  const runtime = {
    agentId: AGENT_ID,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === "ACP_SUBPROCESS_SERVICE" ? acp : null,
    // No connector room → task-policy resolves the permissive client-chat
    // default, the same as a dashboard-originated follow-up.
    getRoom: async () => null,
    reportError: () => undefined,
    // Unparseable model output → the decider's deterministic regex fallback.
    useModel: async () => "{}",
  } as unknown as IAgentRuntime;

  const inbox = new SubAgentInbox();
  const handler = createActiveSessionForwardHandler(runtime, inbox);

  // 1. Follow-up in the origin room of an IDLE session → delivered now.
  await handler({ message: userMessage(ORIGIN_ROOM, FOLLOW_UP) });
  if (delivered.length !== 1) {
    throw new Error(
      `expected exactly one immediate delivery to the idle session, saw ${JSON.stringify(delivered)}`,
    );
  }
  if (
    delivered[0].sessionId !== READY_SESSION ||
    !delivered[0].text.includes(FOLLOW_UP)
  ) {
    throw new Error(
      `follow-up did not reach the origin room's session verbatim: ${JSON.stringify(delivered[0])}`,
    );
  }

  // 2. Follow-up in the room of a BUSY session → queued, never sent mid-turn.
  await handler({ message: userMessage(BUSY_ROOM, BUSY_FOLLOW_UP) });
  if (delivered.length !== 1) {
    throw new Error(
      "a busy session must queue the follow-up, not receive it mid-turn",
    );
  }
  const queuedForBusy = inbox.drain(BUSY_SESSION);
  if (!queuedForBusy?.includes(BUSY_FOLLOW_UP)) {
    throw new Error(
      `busy session's inbox is missing the queued follow-up: ${JSON.stringify(queuedForBusy)}`,
    );
  }

  // 3. A message in an unrelated room reaches no session at all.
  const before = delivered.length;
  await handler({ message: userMessage(OTHER_ROOM, "unrelated chatter") });
  const unrelatedRoomDeliveries = delivered.length - before;
  if (unrelatedRoomDeliveries !== 0) {
    throw new Error("a message in an unbound room must not be forwarded");
  }

  return {
    summary: `follow-up in the origin room was forwarded verbatim to the running session ${READY_SESSION}; a busy session queued it; an unbound room forwarded nothing`,
    deliveredToReady: delivered,
    queuedForBusy,
    unrelatedRoomDeliveries,
  };
}

function forwardingScenarioPlugin(): Plugin {
  const action: Action = {
    name: ACTION_NAME,
    description:
      "Drive the real active-session forward handler: origin-room follow-ups reach the live sub-agent (deliver when idle, queue when busy).",
    validate: async () => true,
    handler: async () => {
      const result = await runForwardingCheck();
      return {
        success: true,
        text: result.summary,
        userFacingText: result.summary,
        verifiedUserFacing: true,
        data: result,
      };
    },
  };
  return {
    name: PLUGIN_NAME,
    description:
      "Deterministic follow-up forwarding scenario action (mid-task origin-room messages).",
    actions: [action],
  };
}

export default scenario({
  id: "orchestrator-follow-up-forwarding",
  lane: "pr-deterministic",
  title:
    "Orchestrator forwards origin-room follow-ups to the running sub-agent session",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "forwarding", "follow-up", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register deterministic follow-up forwarding action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as {
          registerPlugin?: (plugin: Plugin) => Promise<void>;
          plugins?: Array<{ name?: string }>;
        };
        const already = runtime.plugins?.some(
          (plugin) => plugin.name === PLUGIN_NAME,
        );
        if (!already)
          await runtime.registerPlugin?.(forwardingScenarioPlugin());
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "forward a mid-task follow-up from the origin room",
      text: "Post a follow-up in the origin room while the sub-agent is running.",
      actionName: ACTION_NAME,
      responseIncludesAny: ["forwarded verbatim", "queued"],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | ForwardScenarioResult
          | undefined;
        if (!data) return "forwarding scenario produced no data";
        if (data.deliveredToReady[0]?.sessionId !== READY_SESSION) {
          return "expected the idle origin-room session to receive the follow-up";
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: ACTION_NAME,
      status: "success",
    },
    {
      type: "custom",
      name: "origin-room follow-up reached the running session",
      predicate: (ctx) => {
        const data = forwardScenarioData(ctx);
        if (!data) return "forwarding scenario produced no data";
        const hit = data.deliveredToReady.find(
          (d) => d.sessionId === READY_SESSION && d.text.includes(FOLLOW_UP),
        );
        if (!hit) {
          return `follow-up never reached the running session: ${JSON.stringify(data.deliveredToReady)}`;
        }
        if (!data.queuedForBusy?.includes(BUSY_FOLLOW_UP)) {
          return "busy session did not queue the mid-turn follow-up";
        }
        if (data.unrelatedRoomDeliveries !== 0) {
          return "a message in an unbound room was wrongly forwarded";
        }
        return undefined;
      },
    },
  ],
});
