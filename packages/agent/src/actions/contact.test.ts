/**
 * Exercises CONTACT's exported registration and action surfaces across every
 * operation using deterministic in-memory runtime and service collaborators.
 * The suite covers dispatch precedence, create/update/delete lifecycle edges,
 * search/read rendering, activity ordering and bounds, and follow-up routing.
 */
import type {
  Component,
  Entity,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { contactAction, registerEntitySearchCategory } from "./contact.ts";

const AGENT_ID = stringToUuid("contact-test-agent");
const USER_ID = stringToUuid("contact-test-user");
const ROOM_ID = stringToUuid("contact-test-room");
const WORLD_ID = stringToUuid("contact-test-world");

type ServiceRecord = Record<string, unknown>;

interface RuntimeOptions {
  relationships?: ServiceRecord | null;
  followUp?: ServiceRecord | null;
  searchCategoryRegistered?: boolean;
  existingEntity?: Entity | null;
  entitiesInRoom?: Entity[];
  memories?: Memory[];
  component?: Component | null;
  createEntityResult?: boolean;
}

function makePerson(index: number, displayName = `Person ${index}`) {
  const entityId = stringToUuid(`contact-person-${index}`);
  return {
    groupId: entityId,
    primaryEntityId: entityId,
    memberEntityIds: [entityId],
    displayName,
    aliases: [],
    platforms: ["discord"],
    identities: [],
    emails: [],
    phones: [],
    websites: [],
    preferredCommunicationChannel: null,
    categories: [],
    tags: [],
    factCount: 0,
    relationshipCount: 0,
    isOwner: false,
    profiles: [],
    lastInteractionAt: null,
  };
}

function makeGraph(overrides: ServiceRecord = {}): ServiceRecord {
  return {
    getGraphSnapshot: vi.fn(async () => ({ people: [], relationships: [] })),
    getPersonDetail: vi.fn(async () => null),
    getCandidateMerges: vi.fn(async () => []),
    acceptMerge: vi.fn(async () => undefined),
    rejectMerge: vi.fn(async () => undefined),
    proposeMerge: vi.fn(async () => null),
    ...overrides,
  };
}

function makeRuntime(options: RuntimeOptions = {}) {
  const cache = new Map<string, unknown>();
  const relationships =
    options.relationships === undefined ? makeGraph() : options.relationships;
  const registerSearchCategory = vi.fn();
  const createEntity = vi.fn(async () => options.createEntityResult ?? true);
  const updateEntity = vi.fn(async () => undefined);
  const deleteEntities = vi.fn(async () => undefined);
  const getComponent = vi.fn(async () => options.component ?? null);
  const updateComponent = vi.fn(async () => undefined);
  const createComponent = vi.fn(async () => true);

  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Eliza" },
    getSetting: () => undefined,
    getSearchCategory: () => {
      if (!options.searchCategoryRegistered) throw new Error("not registered");
      return { category: "entities" };
    },
    registerSearchCategory,
    getService: (name: string) => {
      if (name === "relationships") return relationships;
      if (name === "follow_up") return options.followUp ?? null;
      return null;
    },
    getEntityById: vi.fn(async () => options.existingEntity ?? null),
    createEntity,
    updateEntity,
    deleteEntities,
    getCache: async <T>(key: string) => (cache.get(key) as T) ?? null,
    setCache: async <T>(key: string, value: T) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    getRoom: vi.fn(async () => ({
      id: ROOM_ID,
      worldId: WORLD_ID,
      name: "Contact room",
    })),
    getWorld: vi.fn(async () => null),
    getEntitiesForRoom: vi.fn(async () => options.entitiesInRoom ?? []),
    getRelationships: vi.fn(async () => []),
    getMemories: vi.fn(async () => options.memories ?? []),
    getComponent,
    updateComponent,
    createComponent,
    useModel: vi.fn(async () => "{}"),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;

  return {
    runtime,
    registerSearchCategory,
    createEntity,
    updateEntity,
    deleteEntities,
    getComponent,
    updateComponent,
    createComponent,
  };
}

function message(text = "manage my contacts"): Memory {
  return {
    id: stringToUuid(`contact-message-${text}`),
    entityId: USER_ID,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    content: { text, source: "client_chat" },
    createdAt: Date.now(),
  } as Memory;
}

async function invoke(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  options: {
    text?: string;
    state?: State;
    callback?: HandlerCallback;
  } = {},
) {
  const result = await contactAction.handler(
    runtime,
    message(options.text),
    options.state,
    { parameters } as never,
    options.callback,
  );
  if (!result) throw new Error("CONTACT returned no result");
  return result;
}

describe("CONTACT exports and dispatch", () => {
  it("registers the Rolodex search category once", () => {
    const missing = makeRuntime();
    registerEntitySearchCategory(missing.runtime);
    expect(missing.registerSearchCategory).toHaveBeenCalledOnce();
    expect(missing.registerSearchCategory).toHaveBeenCalledWith(
      expect.objectContaining({ category: "entities", label: "Rolodex" }),
    );

    const existing = makeRuntime({ searchCategoryRegistered: true });
    registerEntitySearchCategory(existing.runtime);
    expect(existing.registerSearchCategory).not.toHaveBeenCalled();
  });

  it("validates follow-ups directly and other operations from contact signals", async () => {
    const { runtime } = makeRuntime();
    await expect(
      contactAction.validate?.(runtime, message("weather"), undefined, {
        parameters: { action: "followup" },
      } as never),
    ).resolves.toBe(true);
    await expect(
      contactAction.validate?.(runtime, message("find contact Alice")),
    ).resolves.toBe(true);
    await expect(
      contactAction.validate?.(runtime, message("weather")),
    ).resolves.toBe(false);
  });

  it("prefers action over subaction and op, while rejecting unknown operations", async () => {
    const { runtime, createEntity } = makeRuntime();
    const created = await invoke(runtime, {
      action: " CREATE ",
      subaction: "activity",
      op: "search",
      name: "Alice",
    });
    expect(created.success).toBe(true);
    expect(created.data).toMatchObject({ op: "create", name: "Alice" });
    expect(createEntity).toHaveBeenCalledOnce();

    const invalid = await invoke(runtime, { action: "merge" });
    expect(invalid.success).toBe(false);
    expect(invalid.values).toMatchObject({ error: "INVALID" });
  });
});

describe("CONTACT create", () => {
  it("creates an entity with sanitized metadata and promotes rich contact data", async () => {
    const entityId = stringToUuid("created-contact");
    const addContact = vi.fn(async () => true);
    const { runtime, createEntity } = makeRuntime({
      relationships: makeGraph({ addContact }),
    });

    const result = await invoke(runtime, {
      action: "create",
      entityId,
      name: "  Alice  ",
      email: " alice@example.com ",
      phone: " 555-0100 ",
      notes: " met at launch ",
      categories: "friend, founder",
      preferences: "timezone: UTC, language: en",
      attributes: { company: "Acme", ignored: null },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "create",
      entityId,
      name: "Alice",
      promoted: true,
      metadata: {
        email: "alice@example.com",
        phone: "555-0100",
        notes: "met at launch",
        company: "Acme",
      },
    });
    expect(createEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: entityId, names: ["Alice"] }),
    );
    expect(addContact).toHaveBeenCalledWith(
      entityId,
      ["friend", "founder"],
      { timezone: "UTC", language: "en", notes: "met at launch" },
      { displayName: "Alice" },
    );
  });

  it("does not recreate an existing explicit entity", async () => {
    const entityId = stringToUuid("existing-contact");
    const existingEntity: Entity = {
      id: entityId,
      agentId: AGENT_ID,
      names: ["Alice"],
    };
    const { runtime, createEntity } = makeRuntime({ existingEntity });
    const result = await invoke(runtime, {
      action: "create",
      entityId,
      name: "Alice",
    });
    expect(result.success).toBe(true);
    expect(createEntity).not.toHaveBeenCalled();
  });

  it("rejects an empty name and reports a refused create", async () => {
    const empty = makeRuntime();
    const emptyResult = await invoke(empty.runtime, {
      action: "create",
      name: "   ",
    });
    expect(emptyResult.values).toMatchObject({
      error: "INVALID_PARAMETERS",
    });
    expect(empty.createEntity).not.toHaveBeenCalled();

    const refused = makeRuntime({ createEntityResult: false });
    const refusedResult = await invoke(refused.runtime, {
      action: "create",
      name: "Alice",
    });
    expect(refusedResult.values).toMatchObject({ error: "CREATE_FAILED" });
  });
});

describe("CONTACT search and read", () => {
  it("preserves graph ordering, numbers results, and forwards the requested search limit", async () => {
    const first = {
      ...makePerson(1, "Zed"),
      aliases: ["Z"],
      factCount: 2,
    };
    const second = { ...makePerson(2, "Alice"), platforms: [] };
    const getGraphSnapshot = vi.fn(async () => ({
      people: [first, second],
      relationships: [],
    }));
    const { runtime } = makeRuntime({
      relationships: makeGraph({ getGraphSnapshot }),
    });

    const result = await invoke(runtime, {
      action: "search",
      searchTerm: "  ali  ",
      platform: " discord ",
      limit: 500,
    });

    expect(result.success).toBe(true);
    expect(getGraphSnapshot).toHaveBeenCalledWith({
      search: "ali",
      platform: "discord",
      limit: 500,
    });
    expect(result.text).toContain("  1 | Zed (aka Z)");
    expect(result.text).toContain("  2 | Alice — none");
    expect(result.data).toMatchObject({
      results: [
        { line: 1, displayName: "Zed" },
        { line: 2, displayName: "Alice" },
      ],
    });
  });

  it("returns structured failures when search is unavailable or throws", async () => {
    const unavailable = makeRuntime({ relationships: null });
    const missingService = await invoke(unavailable.runtime, {
      action: "search",
      query: "Alice",
    });
    expect(missingService.values).toMatchObject({
      error: "SERVICE_NOT_FOUND",
    });

    const getGraphSnapshot = vi.fn(async () => {
      throw new Error("graph offline");
    });
    const failed = makeRuntime({
      relationships: makeGraph({ getGraphSnapshot }),
    });
    const failure = await invoke(failed.runtime, {
      action: "search",
      query: "Alice",
    });
    expect(failure.success).toBe(false);
    expect(failure.values).toMatchObject({ error: "SEARCH_FAILED" });
    expect(failure.text).toContain("graph offline");
  });

  it("renders complete person details after direct entity-id resolution", async () => {
    const person = makePerson(3, "Alice");
    const other = makePerson(4, "Bob");
    const getPersonDetail = vi.fn(async () => ({
      ...person,
      factCount: 1,
      relationshipCount: 1,
      facts: [{ text: "Likes tea", sourceType: "profile", confidence: 0.875 }],
      recentConversations: [
        {
          roomName: "General",
          lastActivityAt: "2026-08-23T10:00:00.000Z",
          messages: [
            {
              createdAt: Date.parse("2026-08-23T10:00:00.000Z"),
              speaker: "Alice",
              text: "Hello",
            },
          ],
        },
      ],
      relationships: [
        {
          sourcePersonId: person.primaryEntityId,
          sourcePersonName: "Alice",
          targetPersonId: other.primaryEntityId,
          targetPersonName: "Bob",
          relationshipTypes: ["friend"],
          strength: 0.8,
          sentiment: "positive",
          interactionCount: 3,
        },
      ],
    }));
    const { runtime } = makeRuntime({
      relationships: makeGraph({ getPersonDetail }),
    });

    const result = await invoke(runtime, {
      action: "read",
      entityId: person.primaryEntityId,
      name: "Alice",
    });

    expect(result.success).toBe(true);
    expect(getPersonDetail).toHaveBeenCalledWith(person.primaryEntityId);
    expect(result.text).toContain("## Facts");
    expect(result.text).toContain("[profile] (88%) Likes tea");
    expect(result.text).toContain("## Recent Conversations");
    expect(result.text).toContain("Bob: friend");
    expect(result.data).toMatchObject({
      detail: {
        displayName: "Alice",
        factCount: 1,
        conversationCount: 1,
        relationshipCount: 1,
      },
    });
  });

  it("reports missing detail and read exceptions without fabricated success", async () => {
    const missing = makeRuntime();
    const missingResult = await invoke(missing.runtime, {
      action: "read",
      entityId: stringToUuid("missing-detail"),
      name: "Missing",
    });
    expect(missingResult.values).toMatchObject({ error: "ENTITY_NOT_FOUND" });

    const getPersonDetail = vi.fn(async () => {
      throw new Error("detail unavailable");
    });
    const failed = makeRuntime({
      relationships: makeGraph({ getPersonDetail }),
    });
    const failedResult = await invoke(failed.runtime, {
      action: "read",
      entityId: stringToUuid("failed-detail"),
      name: "Failed",
    });
    expect(failedResult.values).toMatchObject({ error: "READ_FAILED" });
  });
});

describe("CONTACT update", () => {
  it("updates entity fields while preserving aliases and metadata", async () => {
    const entityId = stringToUuid("updated-contact");
    const existingEntity: Entity = {
      id: entityId,
      agentId: AGENT_ID,
      names: ["Alice", "Al"],
      metadata: { email: "old@example.com", retained: true },
    };
    const { runtime, updateEntity } = makeRuntime({ existingEntity });

    const result = await invoke(runtime, {
      action: "update",
      entityId,
      name: "Alicia",
      email: "new@example.com",
      phone: "555-0111",
      notes: "Updated",
      attributes: { company: "Acme", ignored: undefined },
    });

    expect(result.success).toBe(true);
    expect(updateEntity).toHaveBeenCalledWith({
      ...existingEntity,
      names: ["Alicia", "Alice", "Al"],
      metadata: {
        email: "new@example.com",
        retained: true,
        phone: "555-0111",
        notes: "Updated",
        company: "Acme",
      },
    });
  });

  it("merges and removes contact-info collections without duplicating entries", async () => {
    const contactId = stringToUuid("contact-info-contact");
    const updateContact = vi.fn(async () => true);
    const searchContacts = vi.fn(async () => [
      {
        entityId: contactId,
        categories: ["friend"],
        tags: ["vip"],
        preferences: { language: "en" },
        customFields: { company: "Acme" },
      },
    ]);
    const callback = vi.fn<HandlerCallback>();
    const { runtime } = makeRuntime({
      relationships: makeGraph({ searchContacts, updateContact }),
    });

    const added = await invoke(
      runtime,
      {
        action: "update",
        name: "Alice",
        categories: "friend, founder",
        tags: ["vip", "investor"],
        preferences: "timezone: UTC",
        customFields: "stage: seed",
        notes: "Call monthly",
        update_mode: "add_to",
      },
      { callback },
    );
    expect(added.success).toBe(true);
    expect(added.turnComplete).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    expect(updateContact).toHaveBeenLastCalledWith(contactId, {
      categories: ["friend", "founder"],
      tags: ["vip", "investor"],
      preferences: {
        language: "en",
        timezone: "UTC",
        notes: "Call monthly",
      },
      customFields: { company: "Acme", stage: "seed" },
    });

    const removed = await invoke(runtime, {
      action: "update",
      name: "Alice",
      categories: ["missing"],
      tags: ["absent"],
      preferences: { missing: "ignored" },
      customFields: { missing: "ignored" },
      update_mode: "remove_from",
    });
    expect(removed.success).toBe(true);
    expect(updateContact).toHaveBeenLastCalledWith(contactId, {
      categories: ["friend"],
      tags: ["vip"],
      preferences: { language: "en" },
      customFields: { company: "Acme" },
    });
  });

  it("creates or replaces source components selected by the real entity resolver", async () => {
    const entityId = stringToUuid("component-contact");
    const entity: Entity = {
      id: entityId,
      agentId: AGENT_ID,
      names: ["Alice"],
    };
    const state = {
      data: {
        room: { id: ROOM_ID, worldId: WORLD_ID, name: "Contact room" },
      },
    } as unknown as State;

    const created = makeRuntime({ entitiesInRoom: [entity] });
    const createdResult = await invoke(
      created.runtime,
      { action: "update", source: " Discord ", data: { handle: "alice" } },
      { text: "Alice", state },
    );
    expect(createdResult.success).toBe(true);
    expect(createdResult.values).toMatchObject({
      componentCreated: true,
      componentType: "discord",
      isNewComponent: true,
    });
    expect(created.createComponent).toHaveBeenCalledOnce();
    expect(created.updateComponent).not.toHaveBeenCalled();

    const existingComponent: Component = {
      id: stringToUuid("existing-component"),
      entityId,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      worldId: WORLD_ID,
      sourceEntityId: USER_ID,
      type: "discord",
      data: { handle: "old" },
      createdAt: 1,
    };
    const updated = makeRuntime({
      entitiesInRoom: [entity],
      component: existingComponent,
    });
    const updatedResult = await invoke(
      updated.runtime,
      { action: "update", source: "discord", data: { handle: "new" } },
      { text: "Alice", state },
    );
    expect(updatedResult.values).toMatchObject({
      componentUpdated: true,
      isNewComponent: false,
    });
    expect(updated.updateComponent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existingComponent.id,
        data: { handle: "new" },
      }),
    );
    expect(updated.createComponent).not.toHaveBeenCalled();
  });

  it("fails clearly for missing update targets", async () => {
    const noId = makeRuntime();
    const invalid = await invoke(noId.runtime, {
      action: "update",
      email: "alice@example.com",
    });
    expect(invalid.values).toMatchObject({ error: "INVALID_PARAMETERS" });

    const missing = makeRuntime({ existingEntity: null });
    const notFound = await invoke(missing.runtime, {
      action: "update",
      entityId: stringToUuid("missing-update-contact"),
      email: "alice@example.com",
    });
    expect(notFound.values).toMatchObject({ error: "NOT_FOUND" });
  });
});

describe("CONTACT delete", () => {
  it("waits for a real second-turn confirmation before deleting by id", async () => {
    const entityId = stringToUuid("deleted-contact");
    const callback = vi.fn<HandlerCallback>();
    const { runtime, deleteEntities } = makeRuntime();

    const pending = await invoke(
      runtime,
      { action: "delete", entityId },
      { text: "delete this contact", callback },
    );
    expect(pending.success).toBe(true);
    expect(pending.data).toMatchObject({
      confirmationRequired: true,
      awaitingUserInput: true,
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(deleteEntities).not.toHaveBeenCalled();

    const confirmed = await invoke(
      runtime,
      { action: "delete", entityId },
      { text: "yes" },
    );
    expect(confirmed.success).toBe(true);
    expect(deleteEntities).toHaveBeenCalledWith([entityId]);
  });

  it("reports a missing name-based removal after confirmation", async () => {
    const searchContacts = vi.fn(async () => []);
    const removeContact = vi.fn(async () => true);
    const { runtime } = makeRuntime({
      relationships: makeGraph({ searchContacts, removeContact }),
    });

    await invoke(
      runtime,
      { action: "delete", name: "Missing" },
      { text: "remove Missing" },
    );
    const result = await invoke(
      runtime,
      { action: "delete", name: "Missing" },
      { text: "yes" },
    );
    expect(result.success).toBe(false);
    expect(result.values).toMatchObject({ error: "NOT_FOUND" });
    expect(removeContact).not.toHaveBeenCalled();
  });
});

describe("CONTACT activity", () => {
  it("orders newest first and preserves insertion order for timestamp ties", async () => {
    const person = {
      ...makePerson(5, "Alice"),
      lastInteractionAt: "2026-08-23T10:00:00.000Z",
    };
    const relationship = {
      sourcePersonId: person.primaryEntityId,
      sourcePersonName: "Alice",
      targetPersonId: stringToUuid("activity-target"),
      targetPersonName: "Bob",
      relationshipTypes: ["friend"],
      sentiment: "positive",
      strength: 0.75,
      interactionCount: 2,
      lastInteractionAt: "2026-08-23T10:00:00.000Z",
    };
    const fact = {
      id: stringToUuid("activity-fact"),
      agentId: AGENT_ID,
      entityId: person.primaryEntityId,
      roomId: ROOM_ID,
      content: { text: "  Likes tea  " },
      metadata: { confidence: 0.9, base: { scope: "personal" } },
      createdAt: Date.parse("2026-08-24T10:00:00.000Z"),
    } as unknown as Memory;
    const getGraphSnapshot = vi.fn(async () => ({
      people: [person],
      relationships: [relationship],
    }));
    const { runtime } = makeRuntime({
      relationships: makeGraph({ getGraphSnapshot }),
      memories: [fact],
    });

    const result = await invoke(runtime, {
      action: "activity",
      limit: 2,
      offset: 0,
    });
    const activity = (
      result.data as { activity: Array<{ type: string; detail: string }> }
    ).activity;
    expect(activity.map((item) => item.type)).toEqual(["fact", "relationship"]);
    expect(activity[0].detail).toBe("Likes tea · personal · confidence 0.90");
    expect(result.data).toMatchObject({ total: 3, count: 2, hasMore: true });

    const full = await invoke(runtime, {
      action: "activity",
      limit: 3,
      offset: 0,
    });
    const tied = (
      full.data as { activity: Array<{ type: string }> }
    ).activity.slice(1);
    expect(tied.map((item) => item.type)).toEqual(["relationship", "identity"]);
  });

  it("uses safe empty defaults and preserves explicitly requested page sizes", async () => {
    const empty = makeRuntime();
    const emptyResult = await invoke(empty.runtime, {
      action: "activity",
      limit: Number.NaN,
      offset: -1,
    });
    expect(emptyResult.values).toMatchObject({
      total: 0,
      count: 0,
      offset: 0,
      limit: undefined,
    });
    expect(emptyResult.text).toContain("(no activity yet)");

    const people = Array.from({ length: 101 }, (_, index) =>
      makePerson(index + 100),
    );
    const getGraphSnapshot = vi.fn(async () => ({
      people,
      relationships: [],
    }));
    const full = makeRuntime({
      relationships: makeGraph({ getGraphSnapshot }),
    });
    const complete = await invoke(full.runtime, {
      action: "activity",
      limit: 1_000,
    });
    expect(complete.values).toMatchObject({
      total: 101,
      count: 101,
      limit: 1_000,
    });
    expect(complete.data).toMatchObject({ hasMore: false });
  });
});

describe("CONTACT followup", () => {
  it("resolves a single named contact and normalizes unsupported priority", async () => {
    const contactId = stringToUuid("followup-contact");
    const searchContacts = vi.fn(async () => [{ entityId: contactId }]);
    const getContact = vi.fn(async () => ({ entityId: contactId }));
    const scheduleFollowUp = vi.fn(async () => ({ id: "followup-task" }));
    const { runtime } = makeRuntime({
      relationships: { searchContacts, getContact },
      followUp: { scheduleFollowUp },
    });

    const result = await invoke(runtime, {
      action: "followup",
      name: " Alice ",
      scheduledAt: "2026-09-01T10:30:00.000Z",
      reason: " Check in ",
      priority: "urgent",
      message: " Hello ",
    });

    expect(result.success).toBe(true);
    expect(scheduleFollowUp).toHaveBeenCalledWith(
      contactId,
      new Date("2026-09-01T10:30:00.000Z"),
      "Check in",
      "medium",
      "Hello",
    );
    expect(result.data).toMatchObject({
      contactId,
      contactName: "Alice",
      taskId: "followup-task",
      priority: "medium",
    });
  });

  it("rejects unavailable services, invalid dates, and missing contacts", async () => {
    const unavailable = makeRuntime({ relationships: null, followUp: null });
    const unavailableResult = await invoke(unavailable.runtime, {
      action: "followup",
    });
    expect(unavailableResult.values).toMatchObject({
      error: "SERVICE_UNAVAILABLE",
    });

    const scheduleFollowUp = vi.fn(async () => ({ id: "unused" }));
    const invalidDate = makeRuntime({
      relationships: {},
      followUp: { scheduleFollowUp },
    });
    const invalidDateResult = await invoke(invalidDate.runtime, {
      action: "followup",
      entityId: stringToUuid("invalid-date-contact"),
      scheduledAt: "not-a-date",
    });
    expect(invalidDateResult.values).toMatchObject({
      error: "INVALID_SCHEDULED_AT",
    });

    const missing = makeRuntime({
      relationships: { searchContacts: vi.fn(async () => []) },
      followUp: { scheduleFollowUp },
    });
    const missingResult = await invoke(missing.runtime, {
      action: "followup",
      name: "Missing",
      scheduledAt: "2026-09-01T10:30:00.000Z",
    });
    expect(missingResult.values).toMatchObject({
      error: "CONTACT_NOT_FOUND",
    });
    expect(scheduleFollowUp).not.toHaveBeenCalled();
  });
});
