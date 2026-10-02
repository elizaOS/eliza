/** Canonical owner cancellation through the real executor/service/PGlite path. */
import {
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  executePlannedToolCall,
  type Memory,
  TaskService,
  type UUID,
} from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  readRecentLifeSaveCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
beforeAll(async () => {
  vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
  fixture = await createLifeOpsTestRuntime({ withLLM: false });
  await TaskService.stop(fixture.runtime);
  service = new LifeOpsService(fixture.runtime);
  const ownerId = service.ownerEntityId() as UUID;
  if (!(await fixture.runtime.getEntityById(ownerId))) {
    await fixture.runtime.createEntity({
      id: ownerId,
      agentId: fixture.runtime.agentId,
      names: ["Cancellation fixture owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Cancellation owner world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Cancellation owner DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );
}, 120_000);
beforeEach(() => {
  vi.spyOn(fixture.runtime, "useModel").mockRejectedValue(
    Error("Canonical cancellation must not invoke a model"),
  );
});
afterEach(() => {
  expect(fixture.runtime.useModel).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
});

async function seed(title: string) {
  return service.createDefinition({
    title,
    description: "Original reminder description",
    kind: "habit",
    timezone: "UTC",
    priority: 3,
    cadence: {
      kind: "once",
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
    reminderPlan: {
      steps: [{ channel: "in_app", offsetMinutes: 0, label: "Notify" }],
    },
  });
}

async function invoke(
  params: Record<string, unknown>,
  text: string,
  userRoles: Array<"OWNER" | "USER"> = ["OWNER"],
  before?: (message: Memory) => Promise<void>,
) {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId:
      userRoles[0] === "OWNER"
        ? (service.ownerEntityId() as UUID)
        : (crypto.randomUUID() as UUID),
    roomId,
    content: { text, source: "client_chat" },
  } as Memory;
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  await before?.(message);
  return executePlannedToolCall(
    fixture.runtime,
    {
      message,
      userRoles,
      activeContexts: ["general", "tasks"],
      replyOwner: "planner",
    },
    { name: "OWNER_REMINDERS", params },
  );
}

it("archives the selected reminder and preserves its plan, occurrence history, and unrelated edit fields", async () => {
  const original = await seed("Sapphire goal reminder");
  const occurrences = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    original.definition.id,
  );
  const audits = await service.repository.listAuditEvents(
    fixture.runtime.agentId,
    "definition",
    original.definition.id,
  );
  const result = await invoke(
    {
      action: "cancel",
      target: original.definition.id,
      title: "Unrequested replacement",
      intent: "Reactivate and reschedule",
      details: {
        status: "active",
        time: "18:00",
        priority: 1,
        description: "Unrequested edit",
      },
    },
    "Cancel my Sapphire goal reminder.",
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  const stored = await service.getDefinition(original.definition.id);
  expect(stored.definition.status).toBe("archived");
  expect({
    ...stored.definition,
    status: original.definition.status,
    updatedAt: original.definition.updatedAt,
  }).toEqual(original.definition);
  expect(stored.reminderPlan).toEqual(original.reminderPlan);
  expect(
    await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      original.definition.id,
    ),
  ).toEqual(occurrences);
  const afterAudits = await service.repository.listAuditEvents(
    fixture.runtime.agentId,
    "definition",
    original.definition.id,
  );
  for (const audit of audits) expect(afterAudits).toContainEqual(audit);
  expect(result.effectReceipts).toEqual([
    expect.objectContaining({
      outcome: "applied",
      operation: "lifeops.definition.update",
      resource: expect.objectContaining({ id: original.definition.id }),
      commit: expect.objectContaining({ kind: "durable" }),
    }),
  ]);
});

it("keeps canonical cancel separate from the recent-save delete/undo path", async () => {
  const selected = await seed("Selected cancellation reminder");
  const recent = await seed("Unrelated recent save");
  let message: Memory | undefined;
  const recentSave = {
    definitionId: recent.definition.id,
    title: recent.definition.title,
    createdAt: Date.now(),
    sourceMessageId: crypto.randomUUID(),
  };
  const result = await invoke(
    { action: "cancel", target: selected.definition.id },
    "Cancel that one.",
    ["OWNER"],
    async (current) => {
      message = current;
      await writeRecentLifeSaveCache(fixture.runtime, current, recentSave);
    },
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(
    (await service.getDefinition(selected.definition.id)).definition.status,
  ).toBe("archived");
  expect(
    (await service.getDefinition(recent.definition.id)).definition,
  ).toEqual(recent.definition);
  if (!message) throw new Error("Missing executed message");
  expect(await readRecentLifeSaveCache(fixture.runtime, message)).toEqual(
    recentSave,
  );
});

it.each(["archived", "paused", "completed"])(
  "ordinary update cannot acquire %s status authority",
  async (status) => {
    const original = await seed(`Ordinary update ${status}`);
    const result = await invoke(
      {
        action: "update",
        target: original.definition.id,
        details: {
          status,
          description: "Authorized note edit",
          cadence: original.definition.cadence,
        },
      },
      "Update this reminder's note; retain its schedule.",
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    const stored = await service.getDefinition(original.definition.id);
    expect(stored.definition.status).toBe("active");
    expect(stored.definition.description).toBe("Authorized note edit");
    expect(stored.definition.cadence).toEqual(original.definition.cadence);
  },
);

it("does not let a non-owner cancellation write the stored reminder", async () => {
  const original = await seed("Owner-only cancellation");
  const result = await invoke(
    { action: "cancel", target: original.definition.id },
    "Cancel this reminder.",
    ["USER"],
  );
  expect(result.success).toBe(false);
  expect(
    (await service.getDefinition(original.definition.id)).definition,
  ).toEqual(original.definition);
});
