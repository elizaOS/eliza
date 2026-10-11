import type {
  Component,
  Entity,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { RelationshipsService } from "../services/relationships.ts";
import { createContactActions } from "./contact.ts";

const CONTACT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const TASK_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;

function createHarness(timeZone: string, contacts: unknown[] = []) {
  const scheduled: Date[] = [];
  const runtime = {
    getSetting: (key: string) => (key === "TIMEZONE" ? timeZone : undefined),
    getService: (name: string) => {
      if (name === "relationships") {
        return { searchContacts: async () => contacts };
      }
      if (name === "follow_up") {
        return {
          scheduleFollowUp: async (_entityId: UUID, scheduledAt: Date) => {
            scheduled.push(scheduledAt);
            return { id: TASK_ID };
          },
        };
      }
      return null;
    },
  } as unknown as IAgentRuntime;
  const { contactAction } = createContactActions({
    resolveGraph: async () => null,
    hasContextSignal: () => false,
  });
  const run = (scheduledAt: string) =>
    contactAction.handler(runtime, {} as Memory, undefined, {
      parameters: {
        action: "followup",
        entityId: CONTACT_ID,
        scheduledAt,
      },
    } as HandlerOptions);
  const runByName = (name: string) =>
    contactAction.handler(runtime, {} as Memory, undefined, {
      parameters: {
        action: "followup",
        name,
        scheduledAt: "2026-10-12T09:00",
      },
    } as HandlerOptions);
  return { run, runByName, scheduled };
}

describe("CONTACT follow-up time", () => {
  it("resolves an offset-less time with seconds in the owner's zone", async () => {
    const { run, scheduled } = createHarness("Asia/Kolkata");

    const result = await run("2026-10-12T09:00:30.125");

    expect(result.success).toBe(true);
    expect(scheduled[0]?.toISOString()).toBe("2026-10-12T03:30:30.125Z");
  });

  it("keeps an explicit numeric offset", async () => {
    const { run, scheduled } = createHarness("America/Los_Angeles");

    const result = await run("2026-10-12T09:00:30+05:30");

    expect(result.success).toBe(true);
    expect(scheduled[0]?.toISOString()).toBe("2026-10-12T03:30:30.000Z");
  });

  it("rejects skipped wall time and other offset-less forms", async () => {
    const { run, scheduled } = createHarness("America/Los_Angeles");

    for (const value of [
      "2026-03-08T02:30:30",
      "2026-10-12 09:00",
      "2026-10-12",
      "10-12-2026",
      "12-Oct-2026",
    ]) {
      const result = await run(value);
      expect(result).toMatchObject({
        success: false,
        data: { error: "INVALID_SCHEDULED_AT" },
      });
    }
    expect(scheduled).toHaveLength(0);
  });

  it("schedules nothing when the name matches more than one contact", async () => {
    const john = "00000000-0000-0000-0000-0000000000c1" as UUID;
    const joanna = "00000000-0000-0000-0000-0000000000c2" as UUID;
    const { runByName, scheduled } = createHarness("Asia/Kolkata", [
      { entityId: john, customFields: { displayName: "John" } },
      { entityId: joanna, customFields: { displayName: "Joanna" } },
    ]);

    const result = await runByName("Jo");

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "AMBIGUOUS_CONTACT",
        matches: [
          { entityId: john, displayName: "John" },
          { entityId: joanna, displayName: "Joanna" },
        ],
      },
    });
    expect(scheduled).toHaveLength(0);
  });
});

/** The real RelationshipsService over an in-memory entity/component store. */
async function createStoreHarness() {
  const agentId = "00000000-0000-0000-0000-0000000000a0" as UUID;
  const entities = new Map<UUID, Entity>();
  const components = new Map<UUID, Component>();
  const scheduled: UUID[] = [];
  const getEntitiesByIds = async (ids: UUID[]) =>
    ids.flatMap((id) => entities.get(id) ?? []);
  const createEntities = async (created: Entity[]) =>
    created.map((entity) => {
      entities.set(entity.id as UUID, entity);
      return entity.id as UUID;
    });
  const createComponents = async (created: Component[]) =>
    created.map((component) => {
      components.set(component.id, component);
      return component.id;
    });
  const tx = {
    getEntitiesByIds,
    createEntities,
    createComponents,
    getComponentsByIds: async (ids: UUID[]) =>
      ids.flatMap((id) => components.get(id) ?? []),
  };
  let relationships: RelationshipsService | null = null;
  const runtime = {
    agentId,
    getSetting: (key: string) => (key === "TIMEZONE" ? "UTC" : undefined),
    queryEntities: async () => [],
    transaction: async (run: (store: typeof tx) => unknown) => run(tx),
    emitEvent: async () => undefined,
    getEntitiesByIds,
    getEntityById: async (id: UUID) => entities.get(id) ?? null,
    getComponent: async (entityId: UUID, type: string, worldId: UUID) =>
      [...components.values()].find(
        (component) =>
          component.entityId === entityId &&
          component.type === type &&
          component.worldId === worldId,
      ) ?? null,
    createComponent: async (component: Component) => {
      components.set(component.id, component);
      return true;
    },
    updateComponent: async (component: Component) => {
      components.set(component.id, component);
    },
    getAllWorlds: async () => [],
    getService: (name: string) => {
      if (name === "relationships") return relationships;
      if (name === "follow_up") {
        return {
          scheduleFollowUp: async (entityId: UUID) => {
            scheduled.push(entityId);
            return { id: TASK_ID };
          },
        };
      }
      return null;
    },
  } as unknown as IAgentRuntime;
  relationships = (await RelationshipsService.start(
    runtime,
  )) as RelationshipsService;
  const { contactAction } = createContactActions({
    resolveGraph: async () => null,
    hasContextSignal: () => false,
  });
  const run = (parameters: Record<string, unknown>, state?: State) =>
    contactAction.handler(
      runtime,
      { roomId: CONTACT_ID, entityId: agentId } as Memory,
      state,
      { parameters } as HandlerOptions,
    );
  return { run, scheduled, components };
}

describe("CONTACT create", () => {
  it("creates a contact that followup and update find by name", async () => {
    const { run, scheduled } = await createStoreHarness();

    const created = await run({
      action: "create",
      name: "Jill Park",
      email: "jill@acme.com",
    });
    expect(created).toMatchObject({
      success: true,
      text: expect.stringContaining('Created contact "Jill Park"'),
    });
    const entityId = created?.values?.entityId as UUID;

    const followup = await run({
      action: "followup",
      name: "Jill Park",
      scheduledAt: "2026-10-19T10:00",
    });
    expect(followup?.success).toBe(true);
    expect(scheduled).toEqual([entityId]);

    const tagged = await run({
      action: "update",
      entityId,
      tags: ["client"],
      update_mode: "add_to",
    });
    expect(tagged?.success).toBe(true);
  });
});

describe("CONTACT update with source and data", () => {
  const WORLD_ID = "00000000-0000-0000-0000-0000000000d0" as UUID;
  const state = { data: { room: { worldId: WORLD_ID } } } as unknown as State;

  it("writes the component to the contact named by entityId", async () => {
    const { run, components } = await createStoreHarness();
    const created = await run({ action: "create", name: "Jill Park" });
    const entityId = created?.values?.entityId as UUID;

    const result = await run(
      {
        action: "update",
        entityId,
        source: "telegram",
        data: { username: "jillp" },
      },
      state,
    );

    expect(result).toMatchObject({ success: true, values: { entityId } });
    expect(
      [...components.values()].find((c) => c.type === "telegram"),
    ).toMatchObject({ entityId, data: { username: "jillp" } });
  });

  it("writes nothing when entityId names no entity", async () => {
    const { run, components } = await createStoreHarness();

    const result = await run(
      {
        action: "update",
        entityId: CONTACT_ID,
        source: "telegram",
        data: { username: "jillp" },
      },
      state,
    );

    expect(result).toMatchObject({
      success: false,
      data: { error: "NOT_FOUND" },
    });
    expect(components.size).toBe(0);
  });
});
