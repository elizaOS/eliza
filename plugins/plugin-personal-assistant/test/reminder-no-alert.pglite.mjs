/** Focused real-store proof: bun --conditions=eliza-source test/reminder-no-alert.pglite.mjs. No providers, live state or scheduler. */
import assert from "node:assert/strict";
import {
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  executePlannedToolCall,
  promoteSubactionsToActions,
} from "../../../packages/core/src/index.ts";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import { goalsDbSchema } from "../../plugin-goals/src/db/schema.ts";
import { remindersDbSchema } from "../../plugin-reminders/src/db/schema.ts";
import { ownerRemindersAction } from "../src/actions/owner-surfaces.ts";
import { lifeOpsSchema } from "../src/lifeops/schema.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";

const dueDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date(Date.now() + 86400000));
const noonUtc = Date.parse(`${dueDate}T12:00:00Z`);
const localHour = Number(
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(noonUtc)),
);
const expectedDueAt = new Date(
  noonUtc - (localHour - 12) * 3600000,
).toISOString();
const fixture = await createTestRuntime({
  plugins: [
    {
      name: "@elizaos/plugin-reminders",
      description: "Reminder schema",
      schema: remindersDbSchema,
    },
    {
      name: "@elizaos/plugin-goals",
      description: "Goal link schema",
      schema: goalsDbSchema,
    },
    {
      name: "@elizaos/plugin-personal-assistant",
      description: "Focused reminder fixture",
      schema: lifeOpsSchema,
      actions: [...promoteSubactionsToActions(ownerRemindersAction)],
    },
  ],
});
let calls = 0;
try {
  const runtime = fixture.runtime;
  runtime.useModel = async () => {
    calls++;
    throw Error("Model not allowed in focused reminder proof");
  };
  const service = new LifeOpsService(runtime);
  const owner = service.ownerEntityId();
  if (!(await runtime.getEntityById(owner)))
    await runtime.createEntity({
      id: owner,
      agentId: runtime.agentId,
      names: ["Fixture owner"],
      metadata: {},
    });
  const worldId = crypto.randomUUID();
  await runtime.ensureWorldExists({
    id: worldId,
    agentId: runtime.agentId,
    name: "Fixture",
    metadata: { ownership: { ownerId: owner }, roles: { [owner]: "OWNER" } },
  });
  const roomId = crypto.randomUUID();
  await runtime.createRoom({
    id: roomId,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Reminder proof",
  });
  await runtime.createRoomParticipants([owner, runtime.agentId], roomId);
  const results = [];
  for (const [title, noAlert] of [
    ["Check silent packing list", true],
    ["Check normal packing list", false],
  ]) {
    const message = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: owner,
      roomId,
      content: {
        source: "client_chat",
        text: `Remind me on ${dueDate} at noon America/Los_Angeles to ${title}. ${noAlert ? "No alert." : ""}`,
      },
    };
    await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
    const result = await executePlannedToolCall(
      runtime,
      {
        message,
        userRoles: ["OWNER"],
        activeContexts: ["general", "tasks"],
        replyOwner: "planner",
      },
      {
        name: "OWNER_REMINDERS_CREATE",
        params: {
          action: "create",
          kind: "definition",
          title,
          details: { noAlert },
          createPlan: {
            mode: "create",
            response: "",
            requestKind: "reminder",
            nativeProjection: "in_app_only",
            title,
            description: null,
            cadenceKind: "once",
            windows: [],
            weekdays: [],
            timeOfDay: "12:00",
            timeZone: "America/Los_Angeles",
            dueDate,
            dueInDays: null,
            dueWeekday: null,
            dueInMinutes: null,
            multiStep: false,
          },
        },
      },
    );
    assert.equal(result.success, true, JSON.stringify(result));
    const definitions = await service.repository.listDefinitions(
      runtime.agentId,
    );
    const target = definitions.find((row) => row.title === title);
    assert.ok(target);
    const stored = await service.getDefinition(target.id);
    assert.equal(stored.definition.cadence.kind, "once");
    assert.equal(stored.definition.cadence.dueAt, expectedDueAt);
    if (noAlert) assert.equal(stored.reminderPlan, null);
    else assert.ok(stored.reminderPlan?.steps.length);
    results.push({
      noAlert,
      saved: true,
      alertSteps: stored.reminderPlan?.steps.length ?? 0,
    });
  }
  const before = (await service.repository.listDefinitions(runtime.agentId))
    .length;
  const deniedMessage = {
    id: crypto.randomUUID(),
    agentId: runtime.agentId,
    entityId: crypto.randomUUID(),
    roomId,
    content: { source: "client_chat", text: "Create a silent reminder." },
  };
  await attestDeliveryAudienceFromCanonicalRoom(runtime, deniedMessage);
  const denied = await executePlannedToolCall(
    runtime,
    {
      message: deniedMessage,
      userRoles: ["USER"],
      activeContexts: ["general", "tasks"],
      replyOwner: "planner",
    },
    {
      name: "OWNER_REMINDERS_CREATE",
      params: {
        action: "create",
        kind: "definition",
        title: "Unauthorized fixture",
        details: { noAlert: true },
      },
    },
  );
  assert.equal(denied.success, false);
  assert.equal(
    (await service.repository.listDefinitions(runtime.agentId)).length,
    before,
  );
  assert.equal(calls, 0);
  console.log(JSON.stringify({ results, modelCalls: calls }));
} finally {
  await fixture.cleanup();
}
