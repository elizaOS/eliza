/** Contract tests asserting @elizaos/plugin-relationships registers its action, provider, and schema. */
import { describe, expect, it } from "vitest";

import { entityAction } from "./actions/entity.js";
import {
  entitiesTable,
  relationshipsSchema,
  relationshipsTable,
} from "./db/schema.js";
import { relationshipsPlugin } from "./plugin.js";
import { entityGraphProvider } from "./providers/entity-graph.js";
import { RELATIONSHIPS_ACTION_NAME } from "./types.js";

describe("@elizaos/plugin-relationships contract", () => {
  it("registers the relationships plugin contract", () => {
    expect(relationshipsPlugin.name).toBe("relationships");
    expect(relationshipsPlugin.dependencies).toContain("@elizaos/plugin-sql");
    expect(relationshipsPlugin.actions).toContain(entityAction);
    expect(relationshipsPlugin.providers).toContain(entityGraphProvider);
    expect(relationshipsPlugin.schema).toMatchObject({
      entitiesTable,
      relationshipsSchema,
      relationshipsTable,
    });
  });

  it("registers the graph-CRUD action as KNOWLEDGE_GRAPH, not ENTITY", () => {
    // PA owns the ENTITY action; this plugin must not collide with it.
    expect(entityAction.name).toBe(RELATIONSHIPS_ACTION_NAME);
    expect(entityAction.name).toBe("KNOWLEDGE_GRAPH");
    expect(entityAction.name).not.toBe("ENTITY");
    for (const action of relationshipsPlugin.actions ?? []) {
      expect(action.name).not.toBe("ENTITY");
    }
  });

  it("provides the ENTITY_GRAPH provider at planner-context position", () => {
    expect(entityGraphProvider.name).toBe("ENTITY_GRAPH");
    expect(entityGraphProvider.position).toBe(-4);
  });
});
