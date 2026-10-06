/**
 * An explicit relationship list limit of 0 is an empty page. A truthy check
 * omitted the limit and the entity store returned every contact.
 */

import type { Entity } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import { RelationshipsDomain } from "./relationships-service.js";

function person(entityId: string): Entity {
  return {
    entityId,
    type: "person",
    preferredName: entityId,
    identities: [],
    state: {},
    tags: ["lifeops:contact"],
    visibility: "owner_only",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function domain() {
  const people = [person("ada"), person("grace")];
  const queries: Array<{ limit?: number }> = [];
  const ctx = {
    agentId: () => "agent-1",
    repository: {
      entityStore: async () => ({
        list: async (query: { limit?: number }) => {
          queries.push(query);
          return query.limit === undefined
            ? people
            : people.slice(0, Math.max(0, query.limit));
        },
      }),
      relationshipStore: async () => ({
        get: async () => null,
      }),
    },
  } as unknown as LifeOpsContext;
  return { domain: new RelationshipsDomain(ctx), queries };
}

describe("RelationshipsDomain explicit empty page", () => {
  it("treats a relationship limit of 0 as an empty page", async () => {
    const { domain: relationships, queries } = domain();

    await expect(
      relationships.listRelationships({ limit: 0 }),
    ).resolves.toEqual([]);
    expect(queries[0]?.limit).toBe(0);

    const one = await relationships.listRelationships({ limit: 1 });
    expect(one.map((contact) => contact.id)).toEqual(["ada"]);

    const all = await relationships.listRelationships();
    expect(all.map((contact) => contact.id)).toEqual(["ada", "grace"]);
    expect(queries[2]?.limit).toBeUndefined();
  });
});
