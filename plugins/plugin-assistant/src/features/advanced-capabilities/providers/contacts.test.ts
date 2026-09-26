/**
 * Unit tests for advanced contacts provider grouping, categorization, and graceful error degradation.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { advancedContactsProvider } from "./contacts.ts";

describe("advancedContactsProvider", () => {
  const dummyMessage = { roomId: "room-1" as UUID } as Memory;
  const dummyState = {} as State;

  it("returns empty result when RelationshipsService is unavailable", async () => {
    const runtime = {
      getService: vi.fn().mockReturnValue(null),
      logger: { warn: vi.fn() },
    } as unknown as IAgentRuntime;

    const result = await advancedContactsProvider.get(
      runtime,
      dummyMessage,
      dummyState,
    );
    expect(result.text).toBe("");
    expect(result.values).toEqual({});
  });

  it("returns no contacts message when searchContacts returns empty list", async () => {
    const relationshipsService = {
      searchContacts: vi.fn().mockResolvedValue([]),
    };
    const runtime = {
      getService: vi.fn().mockReturnValue(relationshipsService),
    } as unknown as IAgentRuntime;

    const result = await advancedContactsProvider.get(
      runtime,
      dummyMessage,
      dummyState,
    );
    expect(result.text).toBe("No contacts in relationships.");
    expect(result.values).toEqual({ contactCount: 0 });
  });

  it("formats and groups contacts by category with tags and details", async () => {
    const mockContacts = [
      {
        entityId: "ent-1" as UUID,
        categories: ["friend"],
        tags: ["close", "tennis"],
        customFields: { displayName: "Alice Smith" },
        preferences: {},
        lastModified: 1000,
      },
      {
        entityId: "ent-2" as UUID,
        categories: ["colleague"],
        tags: ["work"],
        customFields: {},
        preferences: {},
        lastModified: 1000,
      },
    ];

    const relationshipsService = {
      searchContacts: vi.fn().mockResolvedValue(mockContacts),
    };

    const runtime = {
      getService: vi.fn().mockReturnValue(relationshipsService),
      getEntitiesByIds: vi
        .fn()
        .mockResolvedValue([{ id: "ent-2", names: ["Bob Developer"] }]),
      getEntityById: vi.fn(async (id: string) =>
        id === "ent-2" ? { id, names: ["Bob Developer"] } : null,
      ),
    } as unknown as IAgentRuntime;

    const result = await advancedContactsProvider.get(
      runtime,
      dummyMessage,
      dummyState,
    );
    expect(result.text).toContain("You have 2 contacts in your relationships:");
    expect(result.text).toContain("Friends (1):");
    expect(result.text).toContain("- Alice Smith [close, tennis]");
    expect(result.text).toContain("Colleagues (1):");
    expect(result.text).toContain("- Bob Developer [work]");

    expect(result.values).toEqual(
      expect.objectContaining({
        contactCount: 2,
        friend: 1,
        colleague: 1,
      }),
    );
  });

  it("reports error and degrades cleanly when searchContacts throws", async () => {
    const relationshipsService = {
      searchContacts: vi.fn().mockRejectedValue(new Error("Database offline")),
    };

    const runtime = {
      getService: vi.fn().mockReturnValue(relationshipsService),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;

    const result = await advancedContactsProvider.get(
      runtime,
      dummyMessage,
      dummyState,
    );
    expect(runtime.reportError).toHaveBeenCalledWith(
      "ContactsProvider.get",
      expect.any(Error),
      { roomId: "room-1" },
    );
    expect(result.text).toBe("Contact context is unavailable.");
    expect(result.values).toEqual({ contactsAvailable: false });
  });
  it("keeps every contact in order with unordered, missing and repeated entity rows", async () => {
    const contacts = [
      ["first", "First fallback"],
      ["missing", "Missing fallback"],
      ["last", "Last fallback"],
      ["first", "Repeated fallback"],
      ["unnamed", ""],
    ].map(([entityId, displayName]) => ({
      entityId,
      customFields: { displayName },
      categories: ["friend"],
      tags: [],
      preferences: {},
      lastModified: 1,
    }));
    const entities = [
      { id: "last", names: ["Last"] },
      { id: "unnamed", names: [] },
      { id: "first", names: ["First"] },
    ];
    const getEntitiesByIds = vi.fn().mockResolvedValue(entities);
    const getEntityById = vi.fn(
      async (id: string) => entities.find((entity) => entity.id === id) ?? null,
    );
    const runtime = {
      getService: () => ({ searchContacts: async () => contacts }),
      getEntitiesByIds,
      getEntityById,
    } as unknown as IAgentRuntime;
    const result = await advancedContactsProvider.get(
      runtime,
      dummyMessage,
      dummyState,
    );
    expect(result).toEqual({
      text: "You have 5 contacts in your relationships:\n\nFriends (5):\n- First\n- Missing fallback\n- Last\n- First\n- Unknown",
      values: { contactCount: 5, friend: 5 },
      data: { friend: 5 },
    });
    expect(getEntitiesByIds).toHaveBeenCalledExactlyOnceWith([
      "first",
      "missing",
      "last",
      "unnamed",
    ]);
    expect(getEntityById).not.toHaveBeenCalled();
  });

  it("reports a failed entity batch as unavailable rather than an empty contact list", async () => {
    const error = new Error("Entity query failed");
    const reportError = vi.fn();
    const runtime = {
      getService: () => ({
        searchContacts: async () => [{ entityId: "first" }],
      }),
      getEntitiesByIds: vi.fn().mockRejectedValue(error),
      getEntityById: vi.fn().mockRejectedValue(error),
      reportError,
    } as unknown as IAgentRuntime;
    expect(
      await advancedContactsProvider.get(runtime, dummyMessage, dummyState),
    ).toEqual({
      text: "Contact context is unavailable.",
      values: { contactsAvailable: false },
      data: { available: false, error: "Entity query failed" },
    });
    expect(reportError).toHaveBeenCalledWith("ContactsProvider.get", error, {
      roomId: "room-1",
    });
  });
  it("matches canonical SQL entities to uppercase stored contact UUIDs", async () => {
    const id = "aabbccdd-1111-4111-8111-112233445566" as UUID;
    const storedId = id.toUpperCase() as UUID;
    const entity = { id, names: ["Canonical Person"] };
    const runtime = {
      getService: () => ({
        searchContacts: async () => [
          {
            entityId: storedId,
            categories: ["friend"],
            tags: [],
            customFields: { displayName: "Fallback" },
            preferences: {},
            lastModified: 1,
          },
        ],
      }),
      getEntitiesByIds: vi.fn(async () => [entity]),
      getEntityById: vi.fn(async () => entity),
    } as unknown as IAgentRuntime;
    expect(
      await advancedContactsProvider.get(runtime, dummyMessage, dummyState),
    ).toEqual({
      text: "You have 1 contacts in your relationships:\n\nFriends (1):\n- Canonical Person",
      values: { contactCount: 1, friend: 1 },
      data: { friend: 1 },
    });
    expect(runtime.getEntitiesByIds).toHaveBeenCalledExactlyOnceWith([
      storedId,
    ]);
  });
});
