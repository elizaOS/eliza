/**
 * orchestrator-question-for-creator — deterministic, keyless evidence that a
 * sub-agent's QUESTION_FOR_TASK_CREATOR (and a raw `blocked` event, which
 * defaults to that routing kind) surfaces in the task's ORIGIN room.
 *
 * Drives the REAL `SubAgentRouter.handleEvent` over a scripted ACP boundary
 * whose session carries genuine origin metadata; the routing classification,
 * origin resolution, and delivery emission are all shipped code. Delivery is
 * asserted on the runtime surface the router actually posts through
 * (createMemory/emitEvent payloads naming the origin task room and carrying
 * the question text).
 */
import type { Action, IAgentRuntime, Plugin } from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";

const PLUGIN_NAME = "orchestrator-question-for-creator-scenario";
const ACTION_NAME = "ORCHESTRATOR_QUESTION_FOR_CREATOR";

const AGENT_ID = "00000000-0000-4000-8000-0000c4ea1041";
const ORIGIN_ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11";
const TASK_ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22";
const MSG = "11111111-1111-4111-8111-111111111133";
const SESSION = "question-sess-1";
const QUESTION =
  "Should the color palette exclude red-green pairs for color-blind users?";

type QuestionScenarioResult = {
  summary: string;
  deliveredRoomIds: string[];
  deliveredTexts: string[];
  questionReachedOrigin: boolean;
};

function questionScenarioData(
  ctx: ScenarioContext,
): QuestionScenarioResult | null {
  const action = ctx.actionsCalled.find(
    (candidate) => candidate.actionName === ACTION_NAME,
  );
  const data = action?.result?.data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as QuestionScenarioResult)
    : null;
}

async function runQuestionForCreatorCheck(): Promise<QuestionScenarioResult> {
  const sessionInfo = {
    id: SESSION,
    agentType: "codex",
    name: "Ada",
    workdir: "/tmp/question-scenario",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: {
      roomId: ORIGIN_ROOM,
      taskRoomId: TASK_ROOM,
      messageId: MSG,
      originConnectorMessageId: "conn-question-1",
      spawnRootMessageId: MSG,
      source: "discord",
      label: "palette work",
      initialTask: "build the color palette",
    },
  };
  const sessions = new Map([[SESSION, sessionInfo]]);
  let eventHandler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  const acp = {
    onSessionEvent(
      cb: (sessionId: string, event: string, data: unknown) => void,
    ) {
      eventHandler = cb;
      return () => {
        eventHandler = undefined;
      };
    },
    getSession: async (sessionId: string) => sessions.get(sessionId),
    getSessions: async () => [...sessions.values()],
    getChangedPaths: () => [] as string[],
    spawnSession: async () => ({ sessionId: "unused" }),
    stopSession: async () => undefined,
    updateSessionMetadata: async () => undefined,
  };

  // Capture every surface the router can deliver through.
  const created: Array<{ roomId?: string; text?: string }> = [];
  const emitted: Array<unknown> = [];
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Router" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: (type: string) =>
      type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE" ? acp : null,
    createEntity: async () => true,
    addParticipant: async () => true,
    getEntitiesForRoom: async () => [],
    deleteParticipants: async () => true,
    reportError: () => undefined,
    createMemory: async (memory: {
      roomId?: string;
      content?: { text?: string };
    }) => {
      created.push({ roomId: memory.roomId, text: memory.content?.text });
      return MSG;
    },
    emitEvent: async (...args: unknown[]) => {
      emitted.push(args);
      return undefined;
    },
    useModel: async () => "{}",
  } as unknown as IAgentRuntime;

  const router = new SubAgentRouter(runtime);
  await router.start();
  try {
    if (!eventHandler) {
      throw new Error("router never subscribed to ACP session events");
    }
    await (
      router as unknown as {
        handleEvent(
          sessionId: string,
          event: string,
          data: unknown,
        ): Promise<void>;
      }
    )
      // A `blocked` payload carries the sub-agent's prompt in `message`/`prompt`
      // (the shape the ACP transports emit); `blocked` defaults to the
      // QUESTION_FOR_TASK_CREATOR routing kind.
      .handleEvent(SESSION, "blocked", { message: QUESTION });

    const surfaces = [
      ...created.map((c) => JSON.stringify(c)),
      ...emitted.map((e) => JSON.stringify(e)),
    ];
    const deliveredTexts = surfaces.filter((s) => s.includes(QUESTION));
    if (deliveredTexts.length === 0) {
      throw new Error(
        `the sub-agent's question never surfaced on any delivery path: created=${JSON.stringify(created)} emitted=${JSON.stringify(emitted).slice(0, 800)}`,
      );
    }
    // QUESTION_FOR_TASK_CREATOR routes to the origin task room specifically.
    const deliveredRoomIds = [
      ...new Set(
        surfaces
          .filter((s) => s.includes(QUESTION))
          .flatMap((s) =>
            [ORIGIN_ROOM, TASK_ROOM].filter((room) => s.includes(room)),
          ),
      ),
    ];
    const questionReachedOrigin = deliveredRoomIds.length > 0;
    if (!questionReachedOrigin) {
      throw new Error(
        `the question was delivered but not into the origin/task room: ${deliveredTexts.join("\n").slice(0, 800)}`,
      );
    }

    return {
      summary: `QUESTION_FOR_TASK_CREATOR from session ${SESSION} surfaced in the origin task room (${deliveredRoomIds.join(", ")}) with the question text verbatim`,
      deliveredRoomIds,
      deliveredTexts,
      questionReachedOrigin,
    };
  } finally {
    await router.stop();
  }
}

function questionScenarioPlugin(): Plugin {
  const action: Action = {
    name: ACTION_NAME,
    description:
      "Drive the real SubAgentRouter: a blocked sub-agent's question routes to the task creator's origin room.",
    validate: async () => true,
    handler: async () => {
      const result = await runQuestionForCreatorCheck();
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
      "Deterministic QUESTION_FOR_TASK_CREATOR routing scenario action.",
    actions: [action],
  };
}

export default scenario({
  id: "orchestrator-question-for-creator",
  lane: "pr-deterministic",
  title:
    "Orchestrator routes a blocked sub-agent's question to the task creator's room",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "routing", "question", "pr", "deterministic"],
  isolation: "shared-runtime",
  requires: {
    plugins: [PLUGIN_NAME],
  },
  seed: [
    {
      type: "custom",
      name: "register deterministic question-for-creator action",
      apply: async (ctx) => {
        const runtime = ctx.runtime as {
          registerPlugin?: (plugin: Plugin) => Promise<void>;
          plugins?: Array<{ name?: string }>;
        };
        const already = runtime.plugins?.some(
          (plugin) => plugin.name === PLUGIN_NAME,
        );
        if (!already) await runtime.registerPlugin?.(questionScenarioPlugin());
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "route the sub-agent question to the creator",
      text: "A blocked sub-agent asks the task creator a question.",
      actionName: ACTION_NAME,
      responseIncludesAny: ["surfaced in the origin task room"],
      assertTurn: (turn) => {
        const data = turn.actionsCalled[0]?.result?.data as
          | QuestionScenarioResult
          | undefined;
        if (!data?.questionReachedOrigin) {
          return "expected the question to reach the origin room surface";
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
      name: "question text reached the origin task room",
      predicate: (ctx) => {
        const data = questionScenarioData(ctx);
        if (!data) return "question scenario produced no data";
        if (!data.questionReachedOrigin) {
          return "question never reached the origin/task room";
        }
        if (!data.deliveredTexts.some((t) => t.includes(QUESTION))) {
          return "delivered payloads are missing the question text";
        }
        return undefined;
      },
    },
  ],
});
