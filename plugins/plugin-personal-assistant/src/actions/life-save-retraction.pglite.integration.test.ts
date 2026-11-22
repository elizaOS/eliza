/**
 * Replays the owner messages of quint/LifeSaveRetraction.qnt through the
 * production OWNER_REMINDERS path (executePlannedToolCall ->
 * runLifeOperationHandler) on a PGlite-backed runtime. Each case starts from a
 * reminder that was just saved without a preview, so the recent-save cache
 * names it, and the planner answers action=delete for the next message.
 */
import { readFileSync } from "node:fs";
import {
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  executePlannedToolCall,
  type Memory,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  clearRecentLifeSaveCache,
  readRecentLifeSaveCache,
  writeRecentLifeSaveCache,
} from "./lib/lifeops-deferred-draft.js";

/** One owner message of the model and the state the handler must leave. */
interface ModelCase {
  prefix: number;
  mark: number;
  form: number;
  target: number;
  live: boolean;
  cached: boolean;
  removed: boolean;
}

const PREFIXES = ["", "actually ", "no, "];
// The apostrophe of "don't": left out, U+0027, or U+2019 (smart punctuation).
const MARKS = ["", "'", "’"];
const FORMS = ["save that one", "keep it", "forget to set it for 9"];
const TARGETS: Array<string | undefined> = [undefined, "that one"];

const DEFAULT_CASES: ModelCase[] = [
  { prefix: 1, mark: 1, form: 0, target: 0, ...retracted() },
  { prefix: 1, mark: 2, form: 0, target: 0, ...retracted() },
  { prefix: 2, mark: 2, form: 1, target: 1, ...retracted() },
  { prefix: 0, mark: 0, form: 1, target: 0, ...retracted() },
  { prefix: 0, mark: 2, form: 2, target: 0, ...kept() },
  { prefix: 0, mark: 1, form: 2, target: 1, ...kept() },
];

function retracted() {
  return { live: false, cached: false, removed: true };
}

function kept() {
  return { live: true, cached: true, removed: false };
}

const casesFile = process.env.ELIZA_LIFE_SAVE_RETRACTION_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

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
      names: ["Retraction owner"],
      metadata: {},
    });
  }
  const worldId = crypto.randomUUID() as UUID;
  await fixture.runtime.ensureWorldExists({
    id: worldId,
    agentId: fixture.runtime.agentId,
    name: "Retraction owner world",
    metadata: { ownership: { ownerId }, roles: { [ownerId]: "OWNER" } },
  });
  roomId = await fixture.runtime.createRoom({
    id: crypto.randomUUID() as UUID,
    worldId,
    source: "client_chat",
    type: ChannelType.DM,
    name: "Retraction owner DM",
  });
  await fixture.runtime.createRoomParticipants(
    [ownerId, fixture.runtime.agentId],
    roomId,
  );
}, 120_000);

afterAll(async () => {
  await fixture?.cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function conversation(): Memory {
  return { roomId, entityId: service.ownerEntityId() as UUID } as Memory;
}

function messageText(item: ModelCase): string {
  return `${PREFIXES[item.prefix]}don${MARKS[item.mark]}t ${FORMS[item.form]}`;
}

/** Save a reminder the way the crisp-ask fast path does: no preview. */
async function saveWithoutPreview() {
  const record = await service.createDefinition({
    title: "Stretch",
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
  await writeRecentLifeSaveCache(fixture.runtime, conversation(), {
    definitionId: record.definition.id,
    title: record.definition.title,
    createdAt: Date.now(),
    sourceMessageId: crypto.randomUUID(),
  });
  return record.definition.id;
}

async function replay(item: ModelCase) {
  const definitionId = await saveWithoutPreview();
  const target = TARGETS[item.target];
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: fixture.runtime.agentId,
    entityId: service.ownerEntityId() as UUID,
    roomId,
    content: { text: messageText(item), source: "client_chat" },
  } as Memory;
  await attestDeliveryAudienceFromCanonicalRoom(fixture.runtime, message);
  const result = await executePlannedToolCall(
    fixture.runtime,
    {
      message,
      userRoles: ["OWNER"],
      activeContexts: ["general", "tasks"],
      replyOwner: "planner",
    },
    {
      name: "OWNER_REMINDERS",
      params:
        target === undefined
          ? { action: "delete" }
          : { action: "delete", target },
    },
  );
  const live = (await service.listDefinitions()).some(
    (entry) =>
      entry.definition.id === definitionId &&
      entry.definition.status === "active",
  );
  const cached =
    (await readRecentLifeSaveCache(fixture.runtime, conversation()))
      ?.definitionId === definitionId;
  // Leave a clean owner for the next case.
  await clearRecentLifeSaveCache(fixture.runtime, conversation());
  if (live) await service.deleteDefinition(definitionId);
  return { live, cached, removed: result.success === true };
}

for (const [form, name] of FORMS.entries()) {
  it(`life save retraction model replays ${name}`, async () => {
    const group = cases.filter((item) => item.form === form);
    expect(group.length).toBeGreaterThan(0);
    for (const item of group) {
      expect({ text: messageText(item), ...(await replay(item)) }).toEqual({
        text: messageText(item),
        live: item.live,
        cached: item.cached,
        removed: item.removed,
      });
    }
  }, 300_000);
}
