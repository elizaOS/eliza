/** Replays the requests of quint/EscalationPlan.qnt through the owner escalation policy write on PGlite. */
import { readFileSync } from "node:fs";
import type { LifeOpsReminderStep } from "@elizaos/contracts";
import {
  type ActionParameters,
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  type Memory,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import { runLifeOperationHandler } from "./life.js";

/** One step offset per channel in minutes; -1 means the plan has no step there. */
interface ModelPlan {
  inApp: number;
  sms: number;
  voice: number;
}

/** A saved reminder and the requests applied to it, with the plan after each. */
interface ModelCase {
  start: { plan: ModelPlan; quiet: boolean; muted: boolean };
  requests: Array<{
    kind: number;
    plan: ModelPlan;
    quiet: boolean;
    muted: boolean;
  }>;
}

const REQUESTS: Array<{
  name: string;
  text: string;
  details: ActionParameters;
}> = [
  {
    name: "call after 30 minutes",
    text: "for my medication reminder, call me if I don't respond in 30 minutes",
    details: { callAfterMinutes: 30 },
  },
  {
    name: "call after 30 minutes with replace",
    text: "for my medication reminder, just nudge me and then call me after 30 minutes",
    details: { callAfterMinutes: 30, replace: true },
  },
  {
    name: "an sms step at 15 minutes",
    text: "for my medication reminder, text me after 15 minutes",
    details: { steps: [{ channel: "sms", offsetMinutes: 15, label: "Text" }] },
  },
  {
    name: "call after a 20 minute timeout",
    text: "if I ignore my medication reminder for 20 minutes, call me",
    details: { timeoutMinutes: 20 },
  },
];

const QUIET_HOURS = {
  timezone: "UTC",
  startMinute: 22 * 60,
  endMinute: 7 * 60,
};
const MUTE_POLICY = { mutedUntil: "2026-12-01T08:00:00.000Z" };
const CHANNELS = [
  ["inApp", "in_app", "Notify"],
  ["sms", "sms", "Text"],
  ["voice", "voice", "Call"],
] as const;

const plan = (inApp: number, sms: number, voice: number): ModelPlan => ({
  inApp,
  sms,
  voice,
});

// Without generated cases, every first request replays a plan with quiet hours.
const DEFAULT_CASES: ModelCase[] = [
  {
    start: { plan: plan(0, 10, -1), quiet: true, muted: true },
    requests: [{ kind: 0, plan: plan(0, 10, 30), quiet: true, muted: true }],
  },
  {
    start: { plan: plan(-1, 10, 60), quiet: true, muted: false },
    requests: [{ kind: 1, plan: plan(0, -1, 30), quiet: true, muted: false }],
  },
  {
    start: { plan: plan(0, -1, -1), quiet: true, muted: true },
    requests: [
      { kind: 2, plan: plan(0, 15, -1), quiet: true, muted: true },
      { kind: 3, plan: plan(0, 15, 20), quiet: true, muted: true },
    ],
  },
  {
    start: { plan: plan(0, -1, 60), quiet: true, muted: false },
    requests: [{ kind: 3, plan: plan(0, -1, 20), quiet: true, muted: false }],
  },
];

const casesFile = process.env.ELIZA_ESCALATION_PLAN_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

function modelSteps(model: ModelPlan): LifeOpsReminderStep[] {
  return CHANNELS.filter(([key]) => model[key] >= 0).map(
    ([key, channel, label]) => ({
      channel,
      offsetMinutes: model[key],
      label,
    }),
  );
}

function storedPlan(steps: LifeOpsReminderStep[] | undefined): ModelPlan {
  const result = plan(-1, -1, -1);
  for (const [key, channel] of CHANNELS) {
    const matching = (steps ?? []).filter((step) => step.channel === channel);
    expect(matching.length).toBeLessThanOrEqual(1);
    if (matching[0]) result[key] = matching[0].offsetMinutes;
  }
  return result;
}

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
      names: ["Escalation model owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Escalation model world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Escalation model DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
});

// Policy operations reach the shared life handler through the routed
// subaction of OWNER_REMINDERS.
async function configureEscalation(kind: number) {
  const request = REQUESTS[kind];
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    content: { text: request.text, source: "client_chat" },
  } as Memory;
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  return runLifeOperationHandler(fixture.runtime, message, undefined, {
    parameters: {
      action: "policy_configure_escalation",
      subaction: "policy_configure_escalation",
      ownerSurface: "OWNER_REMINDERS",
      target: "Medication",
      details: request.details,
    },
  });
}

async function replay(item: ModelCase): Promise<void> {
  const record = await service.createDefinition({
    title: "Medication",
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
      steps: modelSteps(item.start.plan),
      ...(item.start.quiet ? { quietHours: QUIET_HOURS } : {}),
      ...(item.start.muted ? { mutePolicy: MUTE_POLICY } : {}),
    },
  });
  const id = record.definition.id;
  try {
    const saved = await service.getDefinition(id);
    const savedQuiet = saved.reminderPlan?.quietHours;
    const savedMute = saved.reminderPlan?.mutePolicy;
    expect(storedPlan(saved.reminderPlan?.steps)).toEqual(item.start.plan);
    expect(savedQuiet).toEqual(item.start.quiet ? QUIET_HOURS : {});
    expect(savedMute).toEqual(item.start.muted ? MUTE_POLICY : {});
    for (const [index, step] of item.requests.entries()) {
      const label = `request ${index + 1}: ${REQUESTS[step.kind].name}`;
      const result = await configureEscalation(step.kind);
      expect(result.success, `${label} ${JSON.stringify(result)}`).toBe(true);
      const stored = await service.getDefinition(id);
      const steps = stored.reminderPlan?.steps ?? [];
      expect(storedPlan(steps), label).toEqual(step.plan);
      const offsets = steps.map((entry) => entry.offsetMinutes);
      expect(offsets, label).toEqual([...offsets].sort((a, b) => a - b));
      // The model keeps the saved quiet hours and mute policy unchanged.
      expect(step.quiet, label).toBe(item.start.quiet);
      expect(step.muted, label).toBe(item.start.muted);
      expect(stored.reminderPlan?.quietHours, label).toEqual(savedQuiet);
      expect(stored.reminderPlan?.mutePolicy, label).toEqual(savedMute);
    }
  } finally {
    await service.deleteDefinition(id);
  }
}

describe("escalation plan model", () => {
  it.each(REQUESTS.map((request, kind) => ({ name: request.name, kind })))(
    "replays the escalation plan model when the first request is $name",
    async ({ kind }) => {
      const own = cases.filter((item) => item.requests[0]?.kind === kind);
      expect(own.length).toBeGreaterThan(0);
      for (const item of own) {
        await replay(item);
      }
    },
    600_000,
  );
});
