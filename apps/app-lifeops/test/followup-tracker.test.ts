import { describe, expect, test } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  FOLLOWUP_DEFAULT_THRESHOLD_DAYS,
  FOLLOWUP_MEMORY_TABLE,
  FOLLOWUP_TRACKER_TASK_NAME,
  __resetFollowupTrackerForTests,
  computeOverdueFollowups,
  reconcileFollowupsOnce,
  registerFollowupTrackerWorker,
  type ContactInfo,
  type RelationshipsServiceLike,
} from "../src/followup/index.js";
import { listOverdueFollowupsAction } from "../src/followup/actions/listOverdueFollowups.js";
import { markFollowupDoneAction } from "../src/followup/actions/markFollowupDone.js";
import { setFollowupThresholdAction } from "../src/followup/actions/setFollowupThreshold.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000000" as UUID;
const DAY_MS = 24 * 60 * 60 * 1000;

interface EntityLike {
  id: UUID;
  names: string[];
}

interface TestFixture {
  runtime: IAgentRuntime;
  memories: Array<{ table: string; memory: Memory }>;
  service: RelationshipsServiceLike;
  contacts: ContactInfo[];
  entities: Map<UUID, EntityLike>;
  taskWorkers: Map<string, unknown>;
}

function makeContact(
  id: string,
  fields: Record<string, string | number>,
): ContactInfo {
  return {
    entityId: id as UUID,
    categories: [],
    tags: [],
    customFields: { ...fields },
  };
}

function makeFixture(options: {
  contacts: ContactInfo[];
  withService?: boolean;
}): TestFixture {
  const memories: Array<{ table: string; memory: Memory }> = [];
  const taskWorkers = new Map<string, unknown>();
  const entities = new Map<UUID, EntityLike>();

  for (const contact of options.contacts) {
    const displayName =
      typeof contact.customFields.displayName === "string"
        ? (contact.customFields.displayName as string)
        : String(contact.entityId);
    entities.set(contact.entityId, {
      id: contact.entityId,
      names: [displayName],
    });
  }

  const service: RelationshipsServiceLike = {
    async searchContacts() {
      return options.contacts.map((c) => ({
        ...c,
        customFields: { ...c.customFields },
      }));
    },
    async getContact(entityId: UUID) {
      const match = options.contacts.find((c) => c.entityId === entityId);
      return match
        ? { ...match, customFields: { ...match.customFields } }
        : null;
    },
    async updateContact(entityId: UUID, updates) {
      const idx = options.contacts.findIndex((c) => c.entityId === entityId);
      if (idx === -1) return null;
      const merged: ContactInfo = {
        ...options.contacts[idx],
        customFields: {
          ...options.contacts[idx].customFields,
          ...(updates.customFields ?? {}),
        },
      };
      options.contacts[idx] = merged;
      return merged;
    },
  };

  const runtime = {
    agentId: AGENT_ID,
    getService(name: string) {
      if (name === "relationships" && options.withService !== false) {
        return service as unknown;
      }
      return null;
    },
    async getEntityById(id: UUID) {
      return entities.get(id) ?? null;
    },
    async ensureWorldExists() {
      return undefined;
    },
    async ensureRoomExists() {
      return undefined;
    },
    async createMemory(memory: Memory, table: string) {
      memories.push({ table, memory });
      return memory.id ?? (("mem-" + memories.length) as UUID);
    },
    getTaskWorker(name: string) {
      return taskWorkers.get(name) ?? null;
    },
    registerTaskWorker(worker: { name: string }) {
      taskWorkers.set(worker.name, worker);
    },
  } as unknown as IAgentRuntime;

  return {
    runtime,
    memories,
    service,
    contacts: options.contacts,
    entities,
    taskWorkers,
  };
}

describe("FollowupTracker.computeOverdueFollowups", () => {
  test("returns contacts whose lastContactedAt exceeds the default threshold", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Alice Chen",
          lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
        }),
        makeContact("22222222-2222-2222-2222-222222222222", {
          displayName: "Bob Rivera",
          lastContactedAt: new Date(now - 3 * DAY_MS).toISOString(),
        }),
        makeContact("33333333-3333-3333-3333-333333333333", {
          displayName: "Carol Patel",
          lastContactedAt: new Date(now - 90 * DAY_MS).toISOString(),
        }),
      ],
    });

    const digest = await computeOverdueFollowups(fixture.runtime, now);

    expect(digest.overdue.map((o) => o.displayName)).toEqual([
      "Carol Patel",
      "Alice Chen",
    ]);
    expect(digest.thresholdDefaultDays).toBe(FOLLOWUP_DEFAULT_THRESHOLD_DAYS);
    expect(digest.overdue[0].daysOverdue).toBeGreaterThan(
      digest.overdue[1].daysOverdue,
    );
  });

  test("respects per-contact followupThresholdDays override", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Dana Park",
          followupThresholdDays: 14,
          lastContactedAt: new Date(now - 15 * DAY_MS).toISOString(),
        }),
        makeContact("22222222-2222-2222-2222-222222222222", {
          displayName: "Evan Holt",
          followupThresholdDays: 14,
          lastContactedAt: new Date(now - 10 * DAY_MS).toISOString(),
        }),
      ],
    });

    const digest = await computeOverdueFollowups(fixture.runtime, now);
    expect(digest.overdue.map((o) => o.displayName)).toEqual(["Dana Park"]);
    expect(digest.overdue[0].thresholdDays).toBe(14);
  });

  test("skips contacts without lastContactedAt", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "No History",
        }),
      ],
    });
    const digest = await computeOverdueFollowups(fixture.runtime, now);
    expect(digest.overdue).toEqual([]);
  });

  test("degrades gracefully when RelationshipsService is absent", async () => {
    __resetFollowupTrackerForTests();
    const fixture = makeFixture({ contacts: [], withService: false });
    const digest = await computeOverdueFollowups(fixture.runtime);
    expect(digest.overdue).toEqual([]);
  });
});

describe("FollowupTracker.reconcileFollowupsOnce", () => {
  test("writes a digest memory to the reminders table", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Fiona Gale",
          lastContactedAt: new Date(now - 45 * DAY_MS).toISOString(),
        }),
      ],
    });

    const digest = await reconcileFollowupsOnce(fixture.runtime, now);
    expect(digest.overdue).toHaveLength(1);
    expect(fixture.memories).toHaveLength(1);
    const { table, memory } = fixture.memories[0];
    expect(table).toBe(FOLLOWUP_MEMORY_TABLE);
    expect(memory.content.type).toBe("followup_overdue_digest");
    const metadata = memory.metadata as {
      overdue: Array<{ displayName: string; daysOverdue: number }>;
    };
    expect(metadata.overdue[0].displayName).toBe("Fiona Gale");
    expect(metadata.overdue[0].daysOverdue).toBe(15);
  });
});

describe("FollowupTracker.registerFollowupTrackerWorker", () => {
  test("registers a task worker under FOLLOWUP_TRACKER_TASK_NAME exactly once", () => {
    const fixture = makeFixture({ contacts: [] });
    registerFollowupTrackerWorker(fixture.runtime);
    registerFollowupTrackerWorker(fixture.runtime);
    expect(fixture.taskWorkers.get(FOLLOWUP_TRACKER_TASK_NAME)).toBeDefined();
    expect(fixture.taskWorkers.size).toBe(1);
  });

  test("worker execute runs a reconciler tick end-to-end", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Greg Howe",
          lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
        }),
      ],
    });

    registerFollowupTrackerWorker(fixture.runtime);
    const worker = fixture.taskWorkers.get(FOLLOWUP_TRACKER_TASK_NAME) as {
      execute: (rt: IAgentRuntime) => Promise<unknown>;
    };
    await worker.execute(fixture.runtime);
    expect(fixture.memories).toHaveLength(1);
  });
});

describe("LIST_OVERDUE_FOLLOWUPS action", () => {
  test("lists overdue contacts in output", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Alice Chen",
          lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
        }),
      ],
    });
    const handler = listOverdueFollowupsAction.handler;
    if (!handler) throw new Error("handler missing");
    const result = await handler(fixture.runtime, {} as Memory);
    const actionResult = result as { success: boolean; text: string };
    expect(actionResult.success).toBe(true);
    expect(actionResult.text).toContain("Alice Chen");
  });

  test("returns 'No overdue follow-ups' when none are overdue", async () => {
    const fixture = makeFixture({ contacts: [] });
    const handler = listOverdueFollowupsAction.handler;
    if (!handler) throw new Error("handler missing");
    const result = await handler(fixture.runtime, {} as Memory);
    const actionResult = result as { success: boolean; text: string };
    expect(actionResult.success).toBe(true);
    expect(actionResult.text).toBe("No overdue follow-ups.");
  });
});

describe("MARK_FOLLOWUP_DONE action", () => {
  test("marks contact by id and updates lastContactedAt", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Alice Chen",
          lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
        }),
      ],
    });
    const handler = markFollowupDoneAction.handler;
    if (!handler) throw new Error("handler missing");
    const result = await handler(
      fixture.runtime,
      {} as Memory,
      undefined,
      {
        parameters: {
          contactId: "11111111-1111-1111-1111-111111111111",
        },
      } as never,
    );
    const actionResult = result as {
      success: boolean;
      data?: { lastContactedAt?: string };
    };
    expect(actionResult.success).toBe(true);
    expect(actionResult.data?.lastContactedAt).toBeDefined();
    const stored = await fixture.service.getContact(
      "11111111-1111-1111-1111-111111111111" as UUID,
    );
    const storedValue = stored?.customFields.lastContactedAt;
    expect(typeof storedValue === "string" ? storedValue : "").toBe(
      actionResult.data?.lastContactedAt,
    );
  });

  test("returns ambiguity error when name matches multiple contacts", async () => {
    const now = Date.now();
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Alex Smith",
          lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
        }),
        makeContact("22222222-2222-2222-2222-222222222222", {
          displayName: "Alex Jones",
          lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
        }),
      ],
    });
    const handler = markFollowupDoneAction.handler;
    if (!handler) throw new Error("handler missing");
    const result = await handler(
      fixture.runtime,
      {} as Memory,
      undefined,
      { parameters: { contactName: "Alex" } } as never,
    );
    const actionResult = result as {
      success: boolean;
      text: string;
      data?: { ambiguous?: boolean; candidates?: unknown[] };
    };
    expect(actionResult.success).toBe(false);
    expect(actionResult.text).toContain("Ambiguous");
    expect(actionResult.data?.ambiguous).toBe(true);
    expect(actionResult.data?.candidates).toHaveLength(2);

    // Neither contact should have been modified.
    const first = await fixture.service.getContact(
      "11111111-1111-1111-1111-111111111111" as UUID,
    );
    const second = await fixture.service.getContact(
      "22222222-2222-2222-2222-222222222222" as UUID,
    );
    const firstLast = first?.customFields.lastContactedAt;
    const secondLast = second?.customFields.lastContactedAt;
    expect(typeof firstLast === "string" ? firstLast : "").toBe(
      new Date(now - 60 * DAY_MS).toISOString(),
    );
    expect(typeof secondLast === "string" ? secondLast : "").toBe(
      new Date(now - 60 * DAY_MS).toISOString(),
    );
  });

  test("rejects when neither id nor name is provided", async () => {
    const fixture = makeFixture({ contacts: [] });
    const handler = markFollowupDoneAction.handler;
    if (!handler) throw new Error("handler missing");
    const result = await handler(
      fixture.runtime,
      {} as Memory,
      undefined,
      { parameters: {} } as never,
    );
    const actionResult = result as { success: boolean; text: string };
    expect(actionResult.success).toBe(false);
    expect(actionResult.text).toContain("requires");
  });
});

describe("SET_FOLLOWUP_THRESHOLD action", () => {
  test("sets followupThresholdDays on a contact resolved by id", async () => {
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Dana Park",
        }),
      ],
    });
    const handler = setFollowupThresholdAction.handler;
    if (!handler) throw new Error("handler missing");
    const result = await handler(
      fixture.runtime,
      {} as Memory,
      undefined,
      {
        parameters: {
          contactId: "11111111-1111-1111-1111-111111111111",
          thresholdDays: 14,
        },
      } as never,
    );
    const actionResult = result as {
      success: boolean;
      data?: { thresholdDays?: number };
    };
    expect(actionResult.success).toBe(true);
    expect(actionResult.data?.thresholdDays).toBe(14);
    const stored = await fixture.service.getContact(
      "11111111-1111-1111-1111-111111111111" as UUID,
    );
    expect(stored?.customFields.followupThresholdDays).toBe(14);
  });

  test("rejects non-positive thresholds", async () => {
    const fixture = makeFixture({
      contacts: [
        makeContact("11111111-1111-1111-1111-111111111111", {
          displayName: "Dana Park",
        }),
      ],
    });
    const handler = setFollowupThresholdAction.handler;
    if (!handler) throw new Error("handler missing");
    const result = await handler(
      fixture.runtime,
      {} as Memory,
      undefined,
      {
        parameters: {
          contactId: "11111111-1111-1111-1111-111111111111",
          thresholdDays: 0,
        },
      } as never,
    );
    const actionResult = result as { success: boolean; text: string };
    expect(actionResult.success).toBe(false);
    expect(actionResult.text).toContain("positive");
  });
});
