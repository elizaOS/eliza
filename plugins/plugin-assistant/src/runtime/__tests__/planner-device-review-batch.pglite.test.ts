/**
 * Two phone reviews from one planner reply. Live (Cerebras, synthetic): "Text
 * Sam I'll be late, and set an alarm for 7am." proposed only the text in 0 of
 * 5 runs per arm, although the planner's first reply usually held both calls:
 * the turn paused at the first review and nothing ran the queued alarm later.
 *
 * Real planner loop, real PROPOSE_DEVICE_ACTION handler and a real PGlite
 * approval queue; only the planner model is scripted.
 */
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  AgentRuntime,
  type ContextObject,
  conversationClientUserMemoryId,
  type IDatabaseAdapter,
  type JsonValue,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, expect, it, vi } from "vitest";
import { approvalDispatchControlTable } from "../../../../plugin-sql/src/schema/approvalDispatchControl.ts";
import { approvalRequestTable } from "../../../../plugin-sql/src/schema/approvalRequests.ts";
import { proposeDeviceAction } from "../../services/device-actions/action.ts";
import { DEVICE_CAMERA_CAPTURE_ACTION } from "../../services/device-actions/camera-contract.ts";
import { DEVICE_APPROVAL_REVIEW_TEXT } from "../../services/device-actions/effect-receipts.ts";
import {
  DeviceActionService,
  setDeviceReadReplyContext,
  setDeviceReadReplyConversation,
  withDeviceActionTurn,
} from "../../services/device-actions/service.ts";
import { deviceActionTools } from "../../services/device-actions/tools.ts";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../planner-loop.ts";

afterEach(() => vi.restoreAllMocks());

async function createTable(
  pg: PGlite,
  table: Parameters<typeof getTableConfig>[0],
) {
  const config = getTableConfig(table),
    dialect = new PgDialect();
  const literal = (v: unknown): string =>
    typeof v === "object" && v && "getSQL" in v
      ? dialect.sqlToQuery(v as Parameters<PgDialect["sqlToQuery"]>[0]).sql
      : typeof v === "object"
        ? `'${JSON.stringify(v)}'::jsonb`
        : typeof v === "string"
          ? `'${v.replaceAll("'", "''")}'`
          : String(v);
  await pg.exec(
    `CREATE TABLE ${config.name} (${config.columns
      .map(
        (c) =>
          `${c.name} ${c.getSQLType()}${c.notNull ? " NOT NULL" : ""}${c.default !== undefined ? " DEFAULT " + literal(c.default) : ""}${c.primary ? " PRIMARY KEY" : ""}`,
      )
      .join(
        ",",
      )}${config.primaryKeys.length ? ", " + config.primaryKeys.map((k) => `PRIMARY KEY(${k.columns.map((c) => c.name).join(",")})`).join(",") : ""})`,
  );
}

const CAPABILITIES = [
  "phone.call.v1",
  "contacts.lookup.v1",
  "sms.compose.v1",
  "sms.compose.v2",
  "sms.send.v1",
  "clock.alarms.v1",
  "camera.capture-photo.v1",
];
// The native Clock host's screen-less device context with its Eliza alarm
// snapshot, which a clock proposal binds. With a view added it would break
// the shared observation contract and read as an unreadable screen.
const CLOCK_CONTEXT = {
  revision: 1,
  sensitive: false,
  timeZone: "UTC",
  alarmsStatus: "available",
  alarmsRevision: 3,
  alarms: [],
};
const TEXT_SAM = {
  type: "sms_compose",
  target: { kind: "contact", query: "Sam" },
  body: "I'll be late.",
};
const TEXT_MOM = {
  type: "sms_compose",
  target: { kind: "contact", query: "mom" },
  body: "I'm here.",
};
const ALARM_7 = {
  type: "clock_alarm",
  action: "set",
  hour: 7,
  minute: 0,
  label: "Alarm",
  timeZone: "UTC",
  days: [],
};
// The product's phone negotiates the Clock handoff, not the Eliza alarm
// store, and reports the screen it is showing in a contract-valid
// observation.
const HANDOFF_CAPABILITIES = [
  ...CAPABILITIES.filter((capability) => capability !== "clock.alarms.v1"),
  "clock.handoff.v1",
];
const HANDOFF_7 = {
  type: "clock_handoff",
  action: "set",
  hour: 7,
  minute: 0,
  label: "Alarm",
  timeZone: "UTC",
};
/** The phone's observation of `view`, or the screen-less device context. */
const screen = (view?: string) => ({
  ...(view === undefined ? {} : { view }),
  revision: 1,
  sensitive: false,
  timeZone: "UTC",
});
const PAUSE_THOUGHT =
  "The durable device proposal is waiting for explicit owner input. Requested work remains incomplete; no dependent operation ran.";

type Mode = "direct-request" | "ask-before";
type ScriptedCall = {
  id: string;
  name: string;
  operation?: unknown;
  operationKey?: string;
  args?: Record<string, unknown>;
};
type Decision = "FINISH" | "CONTINUE";

/** VIEWS_SHOW prepared for the renderer, which opens `viewId` after the reply. */
function preparedNavigation(viewId: string) {
  const id = "11111111-1111-4111-8111-111111111111";
  const navigation = {
    effect: "view_navigation",
    status: "prepared",
    viewId,
    path: `/${viewId}`,
    label: viewId,
    handoffId: id,
  };
  return {
    success: true,
    transcriptVisibility: "internal" as const,
    modelReplyRequired: true,
    text: JSON.stringify(navigation),
    data: {
      awaitingDeviceExecution: true,
      navigation,
      values: {
        mode: "show",
        viewId,
        viewPath: `/${viewId}`,
        completedActionDelivered: false,
        completedActionHandoffId: id,
        navigationPrepared: true,
        navigationBinding: {
          requestId: id,
          clientId: "client-1",
          viewId,
          viewType: "gui",
          installationId: "install-1",
        },
      },
    },
  };
}

/** VIEWS_SHOW the phone already applied. */
function deliveredNavigation(viewId: string) {
  return {
    success: true,
    text: `Opened ${viewId}.`,
    data: { values: { mode: "show", viewId, viewPath: `/${viewId}` } },
  };
}

async function fixture(capabilities: readonly string[] = CAPABILITIES) {
  const pg = new PGlite();
  await createTable(pg, approvalRequestTable);
  await createTable(pg, approvalDispatchControlTable);
  await pg.exec(
    "CREATE UNIQUE INDEX approval_unique ON approval_requests(agent_id,idempotency_key) WHERE idempotency_key IS NOT NULL;CREATE TABLE original_memories(id uuid PRIMARY KEY,data jsonb NOT NULL);CREATE TABLE client_devices(agent_id uuid,subject_user_id text,installation_id text,enrollment_id uuid,key_hash text,label text,workflow_protocol integer NOT NULL DEFAULT 0,view_profile text,workflow_owner_id text,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(agent_id,subject_user_id,installation_id));",
  );
  const runtime = new AgentRuntime({
    character: { name: "Eliza", bio: [] },
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter({
    db: drizzle(pg),
  } as unknown as IDatabaseAdapter);
  Object.assign(runtime, {
    getService: (type: string) =>
      type === "notification" ? { notify: vi.fn() } : null,
    redactSecrets: (v: string) => v,
    getSetting: () => null,
  });
  const owner = randomUUID(),
    room = randomUUID() as UUID;
  const credential = {
    subjectUserId: owner,
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities: [...capabilities],
  };
  await new DeviceActionService(runtime).register(
    credential,
    "Synthetic phone",
  );
  const camera = deviceActionTools.find(
    (action) => action.name === DEVICE_CAMERA_CAPTURE_ACTION,
  );
  if (!camera) throw Error("camera tool missing");

  /** One owner turn: the planner answers `calls`, then each of `later` in
   * turn; a planner call past those fails the test. `deviceContext` is the
   * request's `clientDevice.context`; the evaluator answers `decision`. */
  async function turn(
    request: string,
    mode: Mode,
    calls: readonly ScriptedCall[],
    later: readonly (readonly ScriptedCall[])[] = [],
    deviceContext: unknown = {
      ...CLOCK_CONTEXT,
      alarmsObservedAt: Date.now(),
    },
    decision: Decision = "FINISH",
  ) {
    let plans = 0;
    const executed: string[] = [];
    const evaluate = vi.fn(async () =>
      decision === "CONTINUE"
        ? {
            success: true,
            decision,
            requestFullyCovered: false,
            replyEffectStatus: "none" as const,
            thought: "The rest of the request has not been proposed.",
            messageToUser: "",
          }
        : {
            success: true,
            decision,
            thought: "Scripted evaluator.",
            messageToUser: "Scripted evaluator reply.",
          },
    );
    const result = await withDeviceActionTurn(
      runtime,
      credential,
      async () => {
        const nonce = randomUUID(),
          scope = JSON.stringify([runtime.agentId, room, owner]);
        const messageId = conversationClientUserMemoryId(scope, nonce);
        const original: Memory = {
          id: messageId,
          agentId: runtime.agentId,
          entityId: owner as UUID,
          roomId: room,
          createdAt: Date.now(),
          content: {
            text: request,
            source: "client_chat",
            channelType: "DM",
            chatIdempotency: {
              version: 1,
              scope,
              clientMessageId: nonce,
              fingerprint: "e".repeat(64),
            },
            metadata: {
              ...(mode === "direct-request"
                ? { agentActionMode: "direct-request-v1" }
                : {}),
              clientDevice: { context: deviceContext },
            },
          },
        };
        await pg.query("INSERT INTO original_memories VALUES($1,$2)", [
          original.id,
          JSON.stringify(original),
        ]);
        vi.spyOn(runtime, "getMemoryById").mockImplementation(async (id) => {
          const stored = (
            await pg.query<{ data: Memory }>(
              "SELECT data FROM original_memories WHERE id=$1",
              [id],
            )
          ).rows[0]?.data;
          return stored && id === original.id ? stored : null;
        });
        setDeviceReadReplyConversation(runtime, randomUUID(), room);
        const context: ContextObject = {
          id: messageId,
          events: [
            {
              id: "owner",
              type: "message",
              message: { id: messageId, role: "user", content: request },
            },
          ],
        };
        setDeviceReadReplyContext(runtime, original, context);
        return runPlannerLoop({
          context,
          runtime: {
            useModel: async () => {
              const reply = plans === 0 ? calls : later[plans - 1];
              plans++;
              if (!reply) throw Error("Replanned while awaiting review");
              return {
                text: "",
                toolCalls: reply.map((call, index) => ({
                  id: call.id,
                  name: call.name,
                  arguments: JSON.parse(
                    JSON.stringify({
                      ...(call.operation !== undefined
                        ? {
                            operation: call.operation,
                            operationKey: call.operationKey ?? `${call.id}-key`,
                            reason: "The owner asked for this.",
                          }
                        : {}),
                      ...call.args,
                      eliza_turn_scope:
                        index === reply.length - 1
                          ? "final"
                          : "more_work_pending",
                    }),
                  ) as Record<string, JsonValue>,
                })),
              };
            },
          },
          tools: [
            { name: "PROPOSE_DEVICE_ACTION" },
            { name: DEVICE_CAMERA_CAPTURE_ACTION },
            { name: "VIEWS_SHOW" },
            { name: "LATER_EFFECT" },
          ],
          executeToolCall: async (call) => {
            executed.push(call.id ?? call.name);
            if (call.name === "VIEWS_SHOW") {
              const { view, delivered } = call.params as {
                view: string;
                delivered?: boolean;
              };
              return delivered
                ? deliveredNavigation(view)
                : preparedNavigation(view);
            }
            const action =
              call.name === "PROPOSE_DEVICE_ACTION"
                ? proposeDeviceAction
                : call.name === DEVICE_CAMERA_CAPTURE_ACTION
                  ? camera
                  : undefined;
            if (!action?.handler) return { success: true, text: "done" };
            // Core decodes a string `operation` only into the arguments it
            // dispatches (validate-tool-args); the queued call keeps it.
            const { operation } = call.params as { operation?: unknown };
            return actionResultToPlannerToolResult(
              await action.handler(runtime, original, undefined, {
                parameters: (typeof operation === "string"
                  ? { ...call.params, operation: JSON.parse(operation) }
                  : call.params) as JsonValue,
              }),
            );
          },
          evaluate,
        });
      },
      {
        requestCaller: {
          subjectUserId: owner,
          entityId: owner as UUID,
          role: "OWNER",
        },
      },
    );
    return { result, plans, executed, evaluate };
  }
  async function rows() {
    return (
      await pg.query<{ operation: { type: string }; state: string }>(
        "SELECT payload->'operation' AS operation, state FROM approval_requests ORDER BY created_at",
      )
    ).rows;
  }
  return { pg, turn, rows };
}

function expectPause(
  outcome: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["turn"]>>,
) {
  expect(outcome.plans).toBe(1);
  expect(outcome.evaluate).not.toHaveBeenCalled();
  expect(outcome.result.finalMessage).toBe(DEVICE_APPROVAL_REVIEW_TEXT);
  expect(outcome.result.evaluator).toEqual({
    success: false,
    decision: "FINISH",
    requestFullyCovered: false,
    replyEffectStatus: "non_applied",
    thought: PAUSE_THOUGHT,
    messageToUser: DEVICE_APPROVAL_REVIEW_TEXT,
  });
}

it.each(["direct-request", "ask-before"] as const)(
  "records a text and an alarm from one planner reply as two reviews (%s)",
  async (mode) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Text Sam I'll be late, and set an alarm for 7am.",
        mode,
        [
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
        ],
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["text", "alarm"]);
      expect(outcome.result.trajectory.plannedQueue).toEqual([]);
      expect(await f.rows()).toEqual([
        { operation: TEXT_SAM, state: "pending" },
        { operation: ALARM_7, state: "pending" },
      ]);
      // Each is its own durable review; neither ran on the phone.
      for (const step of outcome.result.trajectory.steps)
        expect(step.result?.data).toMatchObject({
          state: "pending",
          executed: false,
          awaitingUserInput: true,
          approvalRequired: true,
        });
    } finally {
      await f.pg.close();
    }
  },
);

// The product's phone image shows one open proposal card at a time on its
// Phone, Messages and Contacts screens: a new card replaces the open one and
// the phone declines the replaced proposal upstream, which stores it as
// rejected. Home and the other screens show each card on its own.
const SCREENS = [
  ["the home screen", 2, screen("home")],
  ["the phone screen", 1, screen("phone")],
  ["the messages screen", 1, screen("messages")],
  ["the contacts screen", 1, screen("contacts")],
  ["no screen", 2, screen()],
  // An observation the shared contract rejects names no trustworthy screen,
  // so it keeps the single-review pause.
  ["an unreadable home observation", 1, { ...screen("home"), extra: 1 }],
  ["an unreadable phone observation", 1, screen("Phone")],
  ["a null observation", 1, null],
] as const;
it.each(
  SCREENS.flatMap(([label, reviews, context]) =>
    (["direct-request", "ask-before"] as const).map(
      (mode) => [label, reviews, mode, context] as const,
    ),
  ),
)(
  "records a text and an alarm sent from %s as %i review(s) (%s)",
  async (_label, reviews, mode, context) => {
    const f = await fixture(HANDOFF_CAPABILITIES);
    try {
      const outcome = await f.turn(
        "Text Sam I'll be late, and set an alarm for 7am.",
        mode,
        [
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: HANDOFF_7 },
        ],
        [],
        context,
      );
      expectPause(outcome);
      // The calls not recorded stay queued and unrun, as before batching.
      const calls = ["text", "alarm"];
      expect(outcome.executed).toEqual(calls.slice(0, reviews));
      expect(
        outcome.result.trajectory.plannedQueue.map((call) => call.id),
      ).toEqual(calls.slice(reviews));
      expect(await f.rows()).toEqual(
        [TEXT_SAM, HANDOFF_7]
          .slice(0, reviews)
          .map((operation) => ({ operation, state: "pending" })),
      );
    } finally {
      await f.pg.close();
    }
  },
);

it.each(["direct-request", "ask-before"] as const)(
  "skips the same text with its number written another way (%s)",
  async (mode) => {
    const f = await fixture();
    try {
      const text = (number: string) => ({
        type: "sms_compose",
        target: { kind: "number", number },
        body: "I'll be late.",
      });
      const outcome = await f.turn(
        "Text 415-555-0100 I'll be late, and set an alarm for 7am.",
        mode,
        [
          {
            id: "text",
            name: "PROPOSE_DEVICE_ACTION",
            operation: text("415-555-0100"),
          },
          {
            id: "text-again",
            name: "PROPOSE_DEVICE_ACTION",
            operation: { ...text("4155550100"), draft: false },
            operationKey: "another-key",
          },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
        ],
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["text", "alarm"]);
      expect(outcome.result.trajectory.plannedQueue).toEqual([]);
      expect(await f.rows()).toEqual([
        { operation: text("4155550100"), state: "pending" },
        { operation: ALARM_7, state: "pending" },
      ]);
      expect(
        outcome.result.trajectory.context.plannedQueue?.find(
          (entry) => entry.id === "text-again",
        )?.status,
      ).toBe("skipped");
    } finally {
      await f.pg.close();
    }
  },
);

// Approving both cards would send the same text twice.
const NEAR_REPEATS = [
  ["a padded body", { ...TEXT_SAM, body: " I'll be late.  " }],
  [
    "a contact name in another case",
    { ...TEXT_SAM, target: { kind: "contact", query: "sam" } },
  ],
] as const;
it.each(
  NEAR_REPEATS.flatMap(([label, repeat]) =>
    (["direct-request", "ask-before"] as const).map(
      (mode) => [label, mode, repeat] as const,
    ),
  ),
)("skips the same text with %s (%s)", async (_label, mode, repeat) => {
  const f = await fixture();
  try {
    const outcome = await f.turn(
      "Text Sam I'll be late, and set an alarm for 7am.",
      mode,
      [
        { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
        {
          id: "text-again",
          name: "PROPOSE_DEVICE_ACTION",
          operation: repeat,
          operationKey: "another-key",
        },
        { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
      ],
    );
    expectPause(outcome);
    expect(outcome.executed).toEqual(["text", "alarm"]);
    expect(await f.rows()).toEqual([
      { operation: TEXT_SAM, state: "pending" },
      { operation: ALARM_7, state: "pending" },
    ]);
    expect(
      outcome.result.trajectory.context.plannedQueue?.find(
        (entry) => entry.id === "text-again",
      )?.status,
    ).toBe("skipped");
  } finally {
    await f.pg.close();
  }
});

// The product's voice path opens a view handed off in this turn before it
// shows the reply's cards, so they land on that screen, not the request's.
// Phone, Messages and Contacts hold one card at a time there; any app-view
// handoff keeps the single-review pause.
const NAVIGATION_TARGETS = ["messages", "phone", "contacts", "home", "notes"];
it.each(
  NAVIGATION_TARGETS.flatMap((target) =>
    (["direct-request", "ask-before"] as const).map(
      (mode) => [target, mode] as const,
    ),
  ),
)(
  "keeps one review after a prepared navigation to %s, then a text and an alarm (%s)",
  async (target, mode) => {
    const f = await fixture(HANDOFF_CAPABILITIES);
    try {
      // The prepared navigation drops the calls queued behind it; the
      // evaluator continues and the replan proposes the text and the alarm.
      const outcome = await f.turn(
        `Open ${target}, text Sam I'll be late, and set an alarm for 7am.`,
        mode,
        [
          { id: "nav", name: "VIEWS_SHOW", args: { view: target } },
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: HANDOFF_7 },
        ],
        [
          [
            {
              id: "text-2",
              name: "PROPOSE_DEVICE_ACTION",
              operation: TEXT_SAM,
            },
            {
              id: "alarm-2",
              name: "PROPOSE_DEVICE_ACTION",
              operation: HANDOFF_7,
            },
          ],
        ],
        screen("home"),
        "CONTINUE",
      );
      expect(outcome.plans).toBe(2);
      expect(outcome.evaluate).toHaveBeenCalledTimes(1);
      expect(outcome.result.finalMessage).toBe(DEVICE_APPROVAL_REVIEW_TEXT);
      expect(outcome.executed).toEqual(["nav", "text-2"]);
      expect(
        outcome.result.trajectory.plannedQueue.map((call) => call.id),
      ).toEqual(["alarm-2"]);
      expect(await f.rows()).toEqual([
        { operation: TEXT_SAM, state: "pending" },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);

it.each(
  ["messages", "notes"].flatMap((target) =>
    (["direct-request", "ask-before"] as const).map(
      (mode) => [target, mode] as const,
    ),
  ),
)(
  "keeps one review after a delivered navigation to %s in the same reply (%s)",
  async (target, mode) => {
    const f = await fixture(HANDOFF_CAPABILITIES);
    try {
      const outcome = await f.turn(
        `Open ${target}, text Sam I'll be late, and set an alarm for 7am.`,
        mode,
        [
          {
            id: "nav",
            name: "VIEWS_SHOW",
            args: { view: target, delivered: true },
          },
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: HANDOFF_7 },
        ],
        [],
        screen("home"),
      );
      // The evaluator reviews the delivered navigation; no replan follows.
      expect(outcome.plans).toBe(1);
      expect(outcome.result.finalMessage).toBe(DEVICE_APPROVAL_REVIEW_TEXT);
      expect(outcome.executed).toEqual(["nav", "text"]);
      expect(
        outcome.result.trajectory.plannedQueue.map((call) => call.id),
      ).toEqual(["alarm"]);
      expect(await f.rows()).toEqual([
        { operation: TEXT_SAM, state: "pending" },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);

/** The planner's `operation` as the direct route sends it, and as the phone's
 * Cloud route does: its planner tools go out non-strict, and the model then
 * writes `operation` as a JSON string, which core decodes only at dispatch. */
const FORMS = [
  ["object", (operation: object): unknown => operation],
  ["JSON string", (operation: object): unknown => JSON.stringify(operation)],
] as const;
const PHOTO = { type: "camera_capture_photo" };
const MODES_AND_FORMS = FORMS.flatMap(([form, write]) =>
  (["direct-request", "ask-before"] as const).map(
    (mode) => [mode, form, write] as const,
  ),
);

it.each(MODES_AND_FORMS)(
  "records a text behind a photo's review card (%s, %s)",
  async (mode, _form, write) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Take a picture and text mom that I'm here.",
        mode,
        [
          {
            id: "photo",
            name: DEVICE_CAMERA_CAPTURE_ACTION,
            operation: write(PHOTO),
          },
          {
            id: "text",
            name: "PROPOSE_DEVICE_ACTION",
            operation: write(TEXT_MOM),
          },
        ],
        // A later model call would propose the text again; none is made.
        [
          [
            {
              id: "text-again",
              name: "PROPOSE_DEVICE_ACTION",
              operation: TEXT_MOM,
            },
          ],
        ],
      );
      // Only a whole-message photo command runs without its card
      // (camera-request.ts), so in both modes the photo is a review here, and
      // the text queued behind it in the same reply gets its own card.
      expectPause(outcome);
      expect(outcome.executed).toEqual(["photo", "text"]);
      expect(outcome.result.trajectory.plannedQueue).toEqual([]);
      expect(await f.rows()).toEqual([
        { operation: PHOTO, state: "pending" },
        { operation: TEXT_MOM, state: "pending" },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);

it.each(FORMS)(
  "records a text and an alarm written as %s as two reviews",
  async (_form, write) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Text Sam I'll be late, and set an alarm for 7am.",
        "direct-request",
        [
          {
            id: "text",
            name: "PROPOSE_DEVICE_ACTION",
            operation: write(TEXT_SAM),
          },
          {
            id: "alarm",
            name: "PROPOSE_DEVICE_ACTION",
            operation: write(ALARM_7),
          },
        ],
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["text", "alarm"]);
      expect(await f.rows()).toEqual([
        { operation: TEXT_SAM, state: "pending" },
        { operation: ALARM_7, state: "pending" },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);

it.each(FORMS)(
  "records a repeated text behind a photo's card once (%s)",
  async (_form, write) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Take a picture and text mom that I'm here.",
        "direct-request",
        [
          {
            id: "photo",
            name: DEVICE_CAMERA_CAPTURE_ACTION,
            operation: write(PHOTO),
          },
          {
            id: "text",
            name: "PROPOSE_DEVICE_ACTION",
            operation: write(TEXT_MOM),
          },
          // The same text again, in the other form: approving two cards
          // would send it twice.
          {
            id: "text-again",
            name: "PROPOSE_DEVICE_ACTION",
            operation: TEXT_MOM,
          },
        ],
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["photo", "text"]);
      expect(await f.rows()).toEqual([
        { operation: PHOTO, state: "pending" },
        { operation: TEXT_MOM, state: "pending" },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);

it("records a first text written as a JSON string once when it is repeated", async () => {
  const f = await fixture();
  try {
    const outcome = await f.turn("Text Sam I'll be late.", "direct-request", [
      {
        id: "text",
        name: "PROPOSE_DEVICE_ACTION",
        operation: JSON.stringify(TEXT_SAM),
      },
      // The same text as an object: the first card's key must read the
      // string the same way, or approving both cards would send it twice.
      { id: "text-again", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
    ]);
    expectPause(outcome);
    expect(outcome.executed).toEqual(["text"]);
    expect(await f.rows()).toEqual([{ operation: TEXT_SAM, state: "pending" }]);
  } finally {
    await f.pg.close();
  }
});

it("keeps the first card's pause when a queued operation string is nested past dispatch's budget", async () => {
  const f = await fixture();
  try {
    // Hostile or degenerate model output: valid JSON nested 4,000 levels.
    const deep = `{"type":"sms_compose","target":{"kind":"contact","query":"mom"},"body":"I'm here.","x":${"[".repeat(4000)}${"]".repeat(4000)}}`;
    const outcome = await f.turn(
      "Take a picture and text mom that I'm here.",
      "direct-request",
      [
        { id: "photo", name: DEVICE_CAMERA_CAPTURE_ACTION, operation: PHOTO },
        { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: deep },
      ],
    );
    expectPause(outcome);
    expect(outcome.executed).toEqual(["photo"]);
    expect(
      outcome.result.trajectory.plannedQueue.map((call) => call.id),
    ).toEqual(["text"]);
    expect(await f.rows()).toEqual([{ operation: PHOTO, state: "pending" }]);
  } finally {
    await f.pg.close();
  }
});

it.each(["direct-request", "ask-before"] as const)(
  "keeps the photo's card when the text behind it cannot be proposed (%s)",
  async (mode) => {
    // A phone with no messaging capability refuses the text.
    const f = await fixture(
      CAPABILITIES.filter((capability) => !capability.startsWith("sms.")),
    );
    try {
      const outcome = await f.turn(
        "Take a picture and text mom that I'm here.",
        mode,
        [
          { id: "photo", name: DEVICE_CAMERA_CAPTURE_ACTION, operation: PHOTO },
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_MOM },
        ],
      );
      // The turn pauses on the photo's card with the review text: it never
      // reaches an evaluator that could claim the text was sent.
      expectPause(outcome);
      expect(await f.rows()).toEqual([{ operation: PHOTO, state: "pending" }]);
    } finally {
      await f.pg.close();
    }
  },
);

it.each(["direct-request", "ask-before"] as const)(
  "records only the photo's card on the messages screen (%s)",
  async (mode) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Take a picture and text mom that I'm here.",
        mode,
        [
          { id: "photo", name: DEVICE_CAMERA_CAPTURE_ACTION, operation: PHOTO },
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_MOM },
        ],
        [],
        screen("messages"),
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["photo"]);
      expect(
        outcome.result.trajectory.plannedQueue.map((call) => call.id),
      ).toEqual(["text"]);
      expect(await f.rows()).toEqual([{ operation: PHOTO, state: "pending" }]);
    } finally {
      await f.pg.close();
    }
  },
);

it.each(["direct-request", "ask-before"] as const)(
  "skips a repeated operation and records the next review (%s)",
  async (mode) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Text Sam I'll be late, and set an alarm for 7am.",
        mode,
        [
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
          {
            id: "text-again",
            name: "PROPOSE_DEVICE_ACTION",
            operation: TEXT_SAM,
            operationKey: "another-key",
          },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
        ],
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["text", "alarm"]);
      expect(outcome.result.trajectory.plannedQueue).toEqual([]);
      expect(await f.rows()).toEqual([
        { operation: TEXT_SAM, state: "pending" },
        { operation: ALARM_7, state: "pending" },
      ]);
      expect(
        outcome.result.trajectory.context.plannedQueue?.find(
          (entry) => entry.id === "text-again",
        )?.status,
      ).toBe("skipped");
    } finally {
      await f.pg.close();
    }
  },
);

it.each(["direct-request", "ask-before"] as const)(
  "stops at the first call that is not a review proposal (%s)",
  async (mode) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Text Sam I'll be late, and set an alarm for 7am.",
        mode,
        [
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
          { id: "later", name: "LATER_EFFECT" },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
        ],
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["text"]);
      expect(
        outcome.result.trajectory.plannedQueue.map((call) => call.id),
      ).toEqual(["later", "alarm"]);
      expect(await f.rows()).toEqual([
        { operation: TEXT_SAM, state: "pending" },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);

it.each(["direct-request", "ask-before"] as const)(
  "never records a kind the phone runs without a card behind a review (%s)",
  async (mode) => {
    const f = await fixture();
    try {
      const outcome = await f.turn(
        "Text Sam I'll be late, take a picture, and set an alarm for 7am.",
        mode,
        [
          { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
          {
            id: "photo",
            name: "PROPOSE_DEVICE_ACTION",
            operation: { type: "camera_capture_photo" },
          },
          { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
        ],
      );
      expectPause(outcome);
      expect(outcome.executed).toEqual(["text"]);
      expect(
        outcome.result.trajectory.plannedQueue.map((call) => call.id),
      ).toEqual(["photo", "alarm"]);
      expect(await f.rows()).toEqual([
        { operation: TEXT_SAM, state: "pending" },
      ]);
    } finally {
      await f.pg.close();
    }
  },
);

it("never records a text the owner asked to draft behind a review", async () => {
  const f = await fixture();
  try {
    // The service turns this text into a draft for the typed number, which
    // the phone puts in Messages right after the reply without a card.
    const outcome = await f.turn(
      "Draft a text to 415-555-0100 saying I'm late, and set an alarm for 7am.",
      "direct-request",
      [
        { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
        {
          id: "text",
          name: "PROPOSE_DEVICE_ACTION",
          operation: {
            type: "sms_compose",
            target: { kind: "number", number: "4155550100" },
            body: "I'm late.",
          },
        },
      ],
    );
    expectPause(outcome);
    expect(outcome.executed).toEqual(["alarm"]);
    expect(
      outcome.result.trajectory.plannedQueue.map((call) => call.id),
    ).toEqual(["text"]);
    expect(await f.rows()).toEqual([{ operation: ALARM_7, state: "pending" }]);
  } finally {
    await f.pg.close();
  }
});

it("stops at a proposal that does not end as a review", async () => {
  const f = await fixture();
  try {
    // The owner wrote no number: the call is refused before persistence and
    // the alarm after it stays queued.
    const outcome = await f.turn(
      "Text Sam I'll be late, call the pharmacy, and set an alarm for 7am.",
      "direct-request",
      [
        { id: "text", name: "PROPOSE_DEVICE_ACTION", operation: TEXT_SAM },
        {
          id: "call",
          name: "PROPOSE_DEVICE_ACTION",
          operation: {
            type: "phone_call",
            target: { kind: "number", number: "6505715862" },
          },
        },
        { id: "alarm", name: "PROPOSE_DEVICE_ACTION", operation: ALARM_7 },
      ],
    );
    expectPause(outcome);
    expect(outcome.executed).toEqual(["text", "call"]);
    expect(outcome.result.trajectory.steps[1]?.result).toMatchObject({
      success: false,
      data: { code: "DEVICE_TELEPHONY_TARGET_NOT_REQUESTED" },
    });
    expect(
      outcome.result.trajectory.plannedQueue.map((call) => call.id),
    ).toEqual(["alarm"]);
    expect(await f.rows()).toEqual([{ operation: TEXT_SAM, state: "pending" }]);
  } finally {
    await f.pg.close();
  }
});
