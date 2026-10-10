/** Canonical owner cancellation through the real executor/service/PGlite path. */
import {
  attestDeliveryAudienceFromCanonicalRoom,
  buildPlannerToolsFromActions,
  ChannelType,
  executePlannedToolCall,
  type Memory,
  type MessageHandlerResult,
  ModelType,
  type ResponseHandlerPatch,
  runResponseHandlerEvaluators,
  TaskService,
  type UUID,
} from "@elizaos/core";
import * as assistant from "@elizaos/plugin-assistant";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { collectV5PlannerCandidateActions } from "../../../plugin-assistant/src/services/message/action-surface.ts";
import { runV5MessageRuntimeStage1 } from "../../../plugin-assistant/src/services/message/pipeline.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../../../plugin-assistant/src/services/message/stage1-evaluators.ts";
import {
  createLifeOpsTestRuntime,
  seedOwnerReminder,
} from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  readRecentLifeSaveCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";

let fixture: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;
let service: LifeOpsService;
let roomId: UUID;
beforeAll(async () => {
  vi.setSystemTime(new Date("2026-10-02T20:00:00.000Z"));
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
  vi.useRealTimers();
});

async function invoke(
  params: Record<string, unknown>,
  text: string,
  userRoles: Array<"OWNER" | "USER"> = ["OWNER"],
  before?: (message: Memory) => Promise<void>,
  toolName = "OWNER_REMINDERS",
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
    { name: toolName, params },
  );
}

it("archives the selected reminder and preserves its plan, occurrence history, and unrelated edit fields", async () => {
  const original = await seedOwnerReminder(service, "Sapphire goal reminder");
  const render = vi
    .spyOn(assistant, "renderGroundedActionReply")
    .mockResolvedValue({ kind: "deferred", grounding: "grounding" });
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
  // With the reply left to the planner, the turn's final reply voices the
  // cancellation from this grounding: the owner's words, not the planner's
  // edit fields.
  expect(result.transcriptVisibility).toBe("internal");
  expect(result.userFacingText).toBeUndefined();
  expect(render.mock.calls).toEqual([
    [
      expect.objectContaining({
        scenario: "cancelled_definition",
        intent: "Cancel my Sapphire goal reminder.",
        context: {
          cancelled: { title: "Sapphire goal reminder", status: "archived" },
        },
      }),
    ],
  ]);
});

/** A one-off reminder that was due an hour ago and has since been cancelled. */
const seedCancelledReminder = async (title: string) =>
  service.updateDefinition(
    (await seedOwnerReminder(service, title, -3_600_000)).definition.id,
    { status: "archived" },
  );

it("cancels the planner's exact title when other titles share only a filler word with the request and a cancelled copy shares its title", async () => {
  const others = [
    await seedOwnerReminder(service, "water the plants"),
    await seedOwnerReminder(service, "Take the trash out"),
    await seedCancelledReminder("Call dentist back"),
  ];
  const dentist = await seedOwnerReminder(service, "Call dentist back");
  try {
    const result = await invoke(
      { action: "cancel", kind: "definition", title: "call dentist back" },
      "pls cancel the dentist reminder",
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(
      (await service.getDefinition(dentist.definition.id)).definition.status,
    ).toBe("archived");
    for (const untouched of others)
      expect(
        (await service.getDefinition(untouched.definition.id)).definition,
      ).toEqual(untouched.definition);
  } finally {
    for (const entry of [...others, dentist])
      await service.deleteDefinition(entry.definition.id);
  }
});

it("cancels the one reminder that can still fire when a cancelled one carries the same title", async () => {
  const cancelled = await seedCancelledReminder("Stretch break");
  const upcoming = await seedOwnerReminder(service, "Stretch break");
  try {
    const result = await invoke(
      { action: "cancel", title: "Stretch break" },
      "cancel my stretch break reminder",
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(
      (await service.getDefinition(upcoming.definition.id)).definition.status,
    ).toBe("archived");
    expect(
      (await service.getDefinition(cancelled.definition.id)).definition,
    ).toEqual(cancelled.definition);
  } finally {
    for (const entry of [cancelled, upcoming])
      await service.deleteDefinition(entry.definition.id);
  }
});

it.each([
  [
    "another title is named with it",
    "Call mom about the trip",
    async () => [
      await seedOwnerReminder(service, "Call mom"),
      await seedCancelledReminder("Call mom about the trip"),
    ],
  ],
  [
    "the only one still open is a todo",
    "Call the vet",
    async () => [
      await service.createDefinition({
        title: "Call the vet",
        kind: "task",
        timezone: "UTC",
        cadence: { kind: "unscheduled" },
        metadata: { ownerSurface: "OWNER_TODOS" },
      }),
      await seedCancelledReminder("Call the vet"),
    ],
  ],
  [
    "a past-due one is snoozed",
    "Stretch break",
    async () => {
      const snoozed = await seedOwnerReminder(
        service,
        "Stretch break",
        -60_000,
      );
      const [occurrence] =
        await service.repository.listOccurrencesForDefinition(
          fixture.runtime.agentId,
          snoozed.definition.id,
        );
      await service.snoozeOccurrence(occurrence.id, { minutes: 30 });
      return [
        snoozed,
        await seedOwnerReminder(service, "Stretch break", 86_400_000),
      ];
    },
  ],
])("asks which reminder to cancel when %s", async (_why, title, seed) => {
  const seeded = await seed();
  try {
    const result = await invoke(
      { action: "cancel", title, target: title },
      `cancel my ${title.toLowerCase()} reminder`,
    );
    expect(result.data).toMatchObject({
      error: "LIFEOPS_TARGET_AMBIGUOUS",
      retryable: false,
    });
    for (const entry of seeded)
      expect(
        (await service.getDefinition(entry.definition.id)).definition,
      ).toEqual(entry.definition);
  } finally {
    for (const entry of seeded)
      await service.deleteDefinition(entry.definition.id);
  }
});

it("keeps canonical cancel separate from the recent-save delete/undo path", async () => {
  const selected = await seedOwnerReminder(
    service,
    "Selected cancellation reminder",
  );
  const recent = await seedOwnerReminder(service, "Unrelated recent save");
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
    const original = await seedOwnerReminder(
      service,
      `Ordinary update ${status}`,
    );
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
  const original = await seedOwnerReminder(service, "Owner-only cancellation");
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

it.each([
  ["complete", "completed"],
  ["skip", "skipped"],
  ["snooze", "snoozed"],
] as const)(
  "%s resolves an exact reminder definition ID to its caller-owned occurrence",
  async (action, expectedState) => {
    const original = await seedOwnerReminder(
      service,
      `Definition-selected reminder ${action}`,
    );
    const unrelated = await seedOwnerReminder(
      service,
      `Unrelated reminder ${action}`,
    );
    const [occurrence] = await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      original.definition.id,
    );
    expect(occurrence).toBeDefined();
    const result = await invoke(
      {
        action,
        target: original.definition.id,
        title: "An unrelated planner title must not select the target",
        ...(action === "snooze" ? { minutes: 10 } : {}),
      },
      action === "complete"
        ? "done"
        : action === "skip"
          ? "skip"
          : "10 minutes",
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(
      (
        await service.repository.getOccurrence(
          fixture.runtime.agentId,
          occurrence.id,
        )
      )?.state,
    ).toBe(expectedState);
    expect(
      (await service.getDefinition(unrelated.definition.id)).definition,
    ).toEqual(unrelated.definition);
  },
);

it("does not let a non-owner complete a definition-selected reminder", async () => {
  const original = await seedOwnerReminder(
    service,
    "Owner-only definition-selected completion",
  );
  const [occurrence] = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    original.definition.id,
  );
  const result = await invoke(
    { action: "complete", target: original.definition.id },
    "done",
    ["USER"],
  );
  expect(result.success).toBe(false);
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrence.id,
    ),
  ).toEqual(occurrence);
});

it("rejects an ambiguous definition without completing either occurrence", async () => {
  const original = await seedOwnerReminder(
    service,
    "Ambiguous definition-selected completion",
  );
  const [occurrence] = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    original.definition.id,
  );
  const second = {
    ...occurrence,
    id: crypto.randomUUID(),
    occurrenceKey: `${occurrence.occurrenceKey}:second`,
  };
  await service.repository.upsertOccurrence(second);
  const result = await invoke(
    { action: "complete", target: original.definition.id },
    "done",
  );
  expect(result.success).toBe(false);
  // The which-one question is evidence for the planner's reply, not a line.
  expect(result.userFacingText).toBeUndefined();
  expect(result.data).toMatchObject({
    error: "LIFEOPS_TARGET_AMBIGUOUS",
    ambiguousCandidates: [expect.any(String), expect.any(String)],
  });
  for (const selected of [occurrence, second]) {
    expect(
      (
        await service.repository.getOccurrence(
          fixture.runtime.agentId,
          selected.id,
        )
      )?.state,
    ).toBe("pending");
  }
});

it("does not substitute a title when the exact definition UUID is unknown", async () => {
  const original = await seedOwnerReminder(
    service,
    "Known title with unknown definition target",
  );
  const result = await invoke(
    {
      action: "complete",
      target: crypto.randomUUID(),
      title: original.definition.title,
    },
    "done",
  );
  expect(result.success).toBe(false);
  expect(
    (await service.getDefinition(original.definition.id)).definition,
  ).toEqual(original.definition);
});

it("requires an occurrence ID for recurring reminders instead of selecting a newer date", async () => {
  const recurring = await service.createDefinition({
    title: "Recurring source-bound reminder",
    kind: "habit",
    timezone: "UTC",
    cadence: { kind: "daily", windows: ["morning"] },
    windowPolicy: {
      timezone: "UTC",
      windows: [
        { name: "morning", label: "Morning", startMinute: 480, endMinute: 600 },
      ],
    },
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
  });
  const occurrences = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    recurring.definition.id,
  );
  const result = await invoke(
    { action: "complete", target: recurring.definition.id },
    "done",
  );
  expect(result.success).toBe(false);
  expect(
    await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      recurring.definition.id,
    ),
  ).toEqual(occurrences);
  const selected = occurrences.find(
    (occurrence) => occurrence.state === "pending",
  );
  if (!selected) throw new Error("Missing recurring source occurrence");
  const boundResult = await invoke(
    { action: "complete", target: selected.id },
    "done",
  );
  expect(boundResult.success, JSON.stringify(boundResult)).toBe(true);
  const after = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    recurring.definition.id,
  );
  expect(after.find((occurrence) => occurrence.id === selected.id)?.state).toBe(
    "completed",
  );
  for (const other of occurrences.filter(
    (occurrence) => occurrence.id !== selected.id,
  )) {
    const stored = after.find((occurrence) => occurrence.id === other.id);
    // The normal cadence refresh may update an expired row's observation time.
    expect({ ...stored, updatedAt: other.updatedAt }).toEqual(other);
  }
});

it("rejects another owner's exact reminder definition ID", async () => {
  const foreignService = new LifeOpsService(fixture.runtime, {
    ownerEntityId: crypto.randomUUID(),
  });
  const foreign = await foreignService.createDefinition({
    title: "Foreign reminder definition",
    kind: "habit",
    timezone: "UTC",
    cadence: {
      kind: "once",
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
  });
  const result = await invoke(
    { action: "complete", target: foreign.definition.id },
    "done",
  );
  expect(result.success).toBe(false);
  expect(
    (await foreignService.getDefinition(foreign.definition.id)).definition,
  ).toEqual(foreign.definition);
});

it("rejects an exact reminder reference outside the requested domain", async () => {
  const original = await seedOwnerReminder(
    service,
    "Domain-bound definition-selected completion",
  );
  const [occurrence] = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    original.definition.id,
  );
  const result = await invoke(
    {
      action: "complete",
      target: original.definition.id,
      details: { domain: "agent_ops" },
    },
    "done",
  );
  expect(result.success).toBe(false);
  expect(
    await service.repository.getOccurrence(
      fixture.runtime.agentId,
      occurrence.id,
    ),
  ).toEqual(occurrence);
});

async function reminderSource(
  original: Awaited<ReturnType<typeof seedOwnerReminder>>,
  changes: Partial<Memory> = {},
) {
  if (changes.roomId && !(await fixture.runtime.getRoom(changes.roomId))) {
    const currentRoom = await fixture.runtime.getRoom(roomId);
    if (!currentRoom?.worldId) throw new Error("Missing fixture world");
    await fixture.runtime.createRoom({
      id: changes.roomId,
      worldId: currentRoom.worldId,
      name: "Foreign source room",
      source: "client_chat",
      type: ChannelType.DM,
    });
  }
  const [occurrence] = await service.repository.listOccurrencesForDefinition(
    fixture.runtime.agentId,
    original.definition.id,
  );
  const source = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: fixture.runtime.agentId,
    roomId,
    createdAt: Date.now(),
    content: {
      text: "Reminder\n\n[CHOICE:lifeops-reminder id=source-choice]\ndone=Done\n10 minutes=Snooze 10m\nskip=Skip\n[/CHOICE]",
      source: "reminder",
      metadata: {
        ownerType: "occurrence",
        ownerId: occurrence.id,
        subjectType: "owner",
        scheduledFor: occurrence.scheduledAt,
        dueAt: occurrence.dueAt,
      },
    },
    ...changes,
  } as Memory;
  await fixture.runtime.createMemory(source, "messages");
  return { source, occurrence };
}

it("executes source-bound Done through the promoted tool after API language augmentation", async () => {
  const original = await seedOwnerReminder(
    service,
    "Actual promoted bound Done",
  );
  const { source, occurrence } = await reminderSource(original);
  const result = await invoke(
    { target: "Check the bound Done button" },
    "done",
    ["OWNER"],
    async (message) => {
      message.content.inReplyTo = source.id;
      message.content.metadata = { reminderChoiceId: "source-choice" };
      message.content.text =
        "done\n\n[Language instruction: Reply in natural English unless the user explicitly requests another language.]";
    },
    "OWNER_REMINDERS_COMPLETE",
  );
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(
    (
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        occurrence.id,
      )
    )?.state,
  ).toBe("completed");
});

it.each([
  ["done", "OWNER_REMINDERS_COMPLETE", "completed"],
  ["skip", "OWNER_REMINDERS_SKIP", "skipped"],
  ["10 minutes", "OWNER_REMINDERS_SNOOZE", "snoozed"],
] as const)(
  "routes typed %s from the captured tasks/household plan directly to %s",
  async (value, operation, state) => {
    const original = await seedOwnerReminder(
      service,
      `Stage-one typed choice ${value}`,
    );
    const { source, occurrence } = await reminderSource(original);
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: fixture.runtime.agentId,
      entityId: service.ownerEntityId() as UUID,
      roomId,
      content: {
        text: `${value}\n\n[Language instruction: Reply in natural English.]`,
        source: "client_chat",
        inReplyTo: source.id,
        metadata: { reminderChoiceId: "source-choice" },
      },
    } as Memory;
    await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
    const messageHandler = {
      processMessage: "RESPOND",
      thought: "Captured tasks routing",
      plan: {
        contexts: ["tasks"],
        requiresTool: true,
        candidateActions: ["HOUSEHOLD_OPERATIONS"],
        intents: ["complete reminder"],
      },
    } as MessageHandlerResult;
    const replyState = { values: {}, data: {}, text: "" };
    await runResponseHandlerEvaluators({
      runtime: fixture.runtime,
      message,
      state: replyState,
      messageHandler,
      availableContexts: [],
      userRoles: ["OWNER"],
      evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS.filter(
        (evaluator) =>
          evaluator.name === "core.direct_registered_capability_request",
      ),
    });
    expect(messageHandler.plan.candidateActions).toEqual([operation]);
    expect(messageHandler.plan.deterministicToolCall).toEqual({
      name: operation,
      params: {},
    });
    const candidates = await collectV5PlannerCandidateActions({
      runtime: fixture.runtime,
      message,
      state: replyState,
      selectedContexts: messageHandler.plan.contexts,
      candidateActions: messageHandler.plan.candidateActions,
      userRoles: ["OWNER"],
    });
    expect(
      buildPlannerToolsFromActions(candidates).map((tool) => tool.name),
    ).toContain(operation);
    const selected = messageHandler.plan.deterministicToolCall;
    if (!selected) throw new Error("Missing deterministic choice");
    const result = await executePlannedToolCall(
      fixture.runtime,
      {
        message,
        state: replyState,
        userRoles: ["OWNER"],
        activeContexts: messageHandler.plan.contexts,
        replyOwner: "planner",
      },
      selected,
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.effectReceipts).toContainEqual(
      expect.objectContaining({
        outcome: "applied",
        resource: expect.objectContaining({ id: occurrence.id }),
      }),
    );
    expect(
      (
        await service.repository.getOccurrence(
          fixture.runtime.agentId,
          occurrence.id,
        )
      )?.state,
    ).toBe(state);
  },
);

it("does not fall back to household operations when the typed choice actor lacks owner access", async () => {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: crypto.randomUUID() as UUID,
    roomId,
    content: {
      text: "done",
      source: "client_chat",
      inReplyTo: crypto.randomUUID() as UUID,
      metadata: { reminderChoiceId: "source-choice" },
    },
  } as Memory;
  const messageHandler = {
    processMessage: "RESPOND",
    thought: "Captured tasks routing",
    plan: {
      contexts: ["tasks"],
      requiresTool: true,
      candidateActions: ["HOUSEHOLD_OPERATIONS"],
    },
  } as MessageHandlerResult;
  await runResponseHandlerEvaluators({
    runtime: fixture.runtime,
    message,
    state: { values: {}, data: {}, text: "" },
    messageHandler,
    availableContexts: [],
    userRoles: ["USER"],
    evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS.filter(
      (evaluator) =>
        evaluator.name === "core.direct_registered_capability_request",
    ),
  });
  expect(messageHandler.plan.requiresTool).toBe(false);
  expect(messageHandler.plan.candidateActions).toBeUndefined();
  expect(messageHandler.plan.deterministicToolCall).toBeUndefined();
});

it("the message pipeline executes a typed Done without an ACTION_PLANNER or discovery call", async () => {
  const original = await seedOwnerReminder(service, "Pipeline typed Done");
  const { source, occurrence } = await reminderSource(original);
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    createdAt: Date.now(),
    content: {
      text: "done\n\n[Language instruction: Reply in natural English.]",
      source: "client_chat",
      inReplyTo: source.id,
      metadata: { reminderChoiceId: "source-choice" },
    },
  } as Memory;
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  const modelTypes: string[] = [];
  vi.mocked(fixture.runtime.useModel).mockImplementation(async (type) => {
    modelTypes.push(String(type));
    if (type === ModelType.RESPONSE_HANDLER)
      return {
        text: "",
        toolCalls: [
          {
            id: "captured-handle",
            name: "HANDLE_RESPONSE",
            arguments: {
              shouldRespond: "RESPOND",
              contexts: ["tasks"],
              contextRequests: [],
              intents: ["complete reminder"],
              replyText: [],
              replyEffectStatus: "pending",
              facts: [],
              relationships: [],
              addressedTo: [service.ownerEntityId()],
              emotion: "none",
            },
          },
        ],
      } as never;
    if (type === ModelType.TEXT_LARGE)
      return 'Marked "Pipeline typed Done" done.' as never;
    throw new Error(`Unexpected model call ${String(type)}`);
  });
  const result = await runV5MessageRuntimeStage1({
    runtime: fixture.runtime,
    message,
    state: { values: {}, data: {}, text: "" },
    responseId: crypto.randomUUID() as UUID,
    deliveredVisibleTexts: new Set(),
    callback: async () => [],
  });
  expect(result.messageHandler.plan.deterministicToolCall?.name).toBe(
    "OWNER_REMINDERS_COMPLETE",
  );
  expect(
    (
      await service.repository.getOccurrence(
        fixture.runtime.agentId,
        occurrence.id,
      )
    )?.state,
  ).toBe("completed");
  expect(modelTypes).not.toContain(ModelType.ACTION_PLANNER);
  expect(
    modelTypes.filter((type) => type === ModelType.RESPONSE_HANDLER),
  ).toHaveLength(1);
  expect(modelTypes).toEqual([ModelType.RESPONSE_HANDLER]);
  expect(result.kind).toBe("planned_reply");
  // This case supplies offline model stand-ins to exercise the real pipeline.
  vi.mocked(fixture.runtime.useModel).mockClear();
});

it.each([
  "missing_reply",
  "bad_reply",
  "bad_choice_id",
  "empty_choice_id",
  "invalid_value",
])(
  "rejects the malformed %s typed envelope before household or discovery fallback",
  async (mode) => {
    const metadata = {
      reminderChoiceId:
        mode === "bad_choice_id"
          ? 42
          : mode === "empty_choice_id"
            ? ""
            : "source-choice",
    };
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: fixture.runtime.agentId,
      entityId: service.ownerEntityId() as UUID,
      roomId,
      content: {
        text: mode === "invalid_value" ? "erase everything" : "done",
        source: "client_chat",
        ...(mode === "missing_reply"
          ? {}
          : {
              inReplyTo: mode === "bad_reply" ? "invalid" : crypto.randomUUID(),
            }),
        metadata,
      },
    } as Memory;
    const messageHandler = {
      processMessage: "RESPOND",
      thought: "Captured tasks routing",
      plan: {
        contexts: ["tasks"],
        requiresTool: true,
        candidateActions: ["HOUSEHOLD_OPERATIONS"],
        parentActionHints: ["HOUSEHOLD_OPERATIONS"],
      },
    } as MessageHandlerResult;
    await runResponseHandlerEvaluators({
      runtime: fixture.runtime,
      message,
      state: { values: {}, data: {}, text: "" },
      messageHandler,
      availableContexts: [],
      userRoles: ["OWNER"],
      evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS.filter(
        (evaluator) =>
          evaluator.name === "core.direct_registered_capability_request",
      ),
    });
    expect(messageHandler.plan.requiresTool).toBe(false);
    expect(messageHandler.plan.candidateActions).toBeUndefined();
    expect(messageHandler.plan.parentActionHints).toBeUndefined();
    expect(messageHandler.plan.deterministicToolCall).toBeUndefined();
  },
);

it("does not take ownership of ordinary done text without typed control metadata", async () => {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    content: { text: "done", source: "client_chat" },
  } as Memory;
  const messageHandler = {
    processMessage: "RESPOND",
    thought: "Ordinary text",
    plan: {
      contexts: ["tasks"],
      requiresTool: true,
      candidateActions: ["HOUSEHOLD_OPERATIONS"],
    },
  } as MessageHandlerResult;
  await runResponseHandlerEvaluators({
    runtime: fixture.runtime,
    message,
    state: { values: {}, data: {}, text: "" },
    messageHandler,
    availableContexts: [],
    userRoles: ["OWNER"],
    evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS.filter(
      (evaluator) =>
        evaluator.name === "core.direct_registered_capability_request",
    ),
  });
  expect(messageHandler.plan.candidateActions).toEqual([
    "HOUSEHOLD_OPERATIONS",
  ]);
  expect(messageHandler.plan.deterministicToolCall).toBeUndefined();
});

it.each(["applied", "pending"] as const)(
  "keeps malformed control terminal after FULL routing with inherited %s status",
  async (replyEffectStatus) => {
    const handler = vi.fn(async () => ({
      success: true,
      text: "Unrelated write",
    }));
    fixture.runtime.registerAction({
      name: "UNRELATED_WRITER",
      description: "Perform an unrelated write",
      contexts: ["general", "tasks"],
      similes: ["UNRELATED_WRITER"],
      validate: async () => true,
      handler,
    });
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: fixture.runtime.agentId,
      entityId: service.ownerEntityId() as UUID,
      roomId,
      content: {
        text: "UNRELATED_WRITER",
        source: "client_chat",
        metadata: { reminderChoiceId: "source-choice" },
      },
    } as Memory;
    await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
    const messageHandler = {
      processMessage: "RESPOND",
      thought: "Inherited model claim",
      plan: {
        contexts: ["tasks"],
        requiresTool: true,
        candidateActions: ["HOUSEHOLD_OPERATIONS"],
        parentActionHints: ["HOUSEHOLD_OPERATIONS"],
        replyEffectStatus,
        reply: "Done, unrelated state was updated.",
      },
    } as MessageHandlerResult;
    const definitionsBefore = await service.listDefinitions();
    await runResponseHandlerEvaluators({
      runtime: fixture.runtime,
      message,
      state: { values: {}, data: {}, text: "" },
      messageHandler,
      availableContexts: [],
      userRoles: ["OWNER"],
      evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS,
    });
    expect(messageHandler.plan.requiresTool).toBe(false);
    expect(messageHandler.plan.replyEffectStatus).toBe("non_applied");
    expect(messageHandler.plan.candidateActions).toBeUndefined();
    expect(messageHandler.plan.parentActionHints).toBeUndefined();
    expect(messageHandler.plan.deterministicToolCall).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(await service.listDefinitions()).toEqual(definitionsBefore);
  },
);

it.each([
  ["non_applied", "non_applied"],
  ["applied", "pending"],
  ["omitted", "pending"],
] as const)(
  "the patch status setter accepts only terminal no-effect: %s",
  async (requested, expected) => {
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: fixture.runtime.agentId,
      entityId: service.ownerEntityId() as UUID,
      roomId,
      content: { text: "neutral text", source: "client_chat" },
    } as Memory;
    const messageHandler = {
      processMessage: "RESPOND",
      thought: "Patch compatibility",
      plan: {
        contexts: ["simple"],
        requiresTool: false,
        replyEffectStatus: "pending",
      },
    } as MessageHandlerResult;
    await runResponseHandlerEvaluators({
      runtime: fixture.runtime,
      message,
      state: { values: {}, data: {}, text: "" },
      messageHandler,
      availableContexts: [],
      userRoles: ["OWNER"],
      evaluators: [
        {
          name: "fixture.status-patch",
          shouldRun: () => true,
          evaluate: () =>
            ({
              ...(requested === "omitted"
                ? {}
                : { replyEffectStatus: requested }),
            }) as unknown as ResponseHandlerPatch,
        },
      ],
    });
    expect(messageHandler.plan.replyEffectStatus).toBe(expected);
    expect(messageHandler.plan.requiresTool).toBe(false);
  },
);

it.each([
  ["done", "completed"],
  ["skip", "skipped"],
  ["10 minutes", "snoozed"],
] as const)(
  "binds clicked %s to the canonical source occurrence despite an unrelated planner target",
  async (value, state) => {
    const original = await seedOwnerReminder(service, `Bound choice ${value}`);
    const other = await seedOwnerReminder(
      service,
      `Concurrent reminder ${value}`,
    );
    const { source, occurrence } = await reminderSource(original);
    const result = await invoke(
      { action: "complete", target: other.definition.id },
      value,
      ["OWNER"],
      async (message) => {
        message.content.inReplyTo = source.id;
        message.content.metadata = { reminderChoiceId: "source-choice" };
      },
    );
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(
      (
        await service.repository.getOccurrence(
          fixture.runtime.agentId,
          occurrence.id,
        )
      )?.state,
    ).toBe(state);
    const [unrelated] = await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      other.definition.id,
    );
    expect(unrelated.state).toBe("pending");
  },
);

it.each([
  "missing",
  "foreign_room",
  "foreign_author",
  "wrong_choice",
  "unbound",
  "stale",
  "tampered_value",
])(
  "rejects %s reminder choice sources without falling back to the planner target",
  async (mode) => {
    const original = await seedOwnerReminder(
      service,
      `Rejected source ${mode}`,
    );
    const other = await seedOwnerReminder(
      service,
      `Protected planner target ${mode}`,
    );
    const { source, occurrence } = await reminderSource(original, {
      ...(mode === "foreign_room"
        ? { roomId: crypto.randomUUID() as UUID }
        : {}),
      ...(mode === "foreign_author"
        ? { entityId: service.ownerEntityId() as UUID }
        : {}),
      ...(mode === "unbound"
        ? {
            content: {
              text: "[CHOICE:lifeops-reminder id=source-choice]\ndone=Done\n[/CHOICE]",
              source: "reminder",
            },
          }
        : {}),
    });
    if (mode === "stale")
      await service.repository.upsertOccurrence({
        ...occurrence,
        state: "expired",
      });
    const result = await invoke(
      { action: "complete", target: other.definition.id },
      mode === "tampered_value" ? "erase everything" : "done",
      ["OWNER"],
      async (message) => {
        message.content.inReplyTo =
          mode === "missing" ? (crypto.randomUUID() as UUID) : source.id;
        message.content.metadata = {
          reminderChoiceId:
            mode === "wrong_choice" ? "forged-choice" : "source-choice",
        };
      },
    );
    expect(result.success).toBe(false);
    const [unrelated] = await service.repository.listOccurrencesForDefinition(
      fixture.runtime.agentId,
      other.definition.id,
    );
    expect(unrelated.state).toBe("pending");
    expect(
      (
        await service.repository.getOccurrence(
          fixture.runtime.agentId,
          occurrence.id,
        )
      )?.state,
    ).toBe(mode === "stale" ? "expired" : "pending");
  },
);
