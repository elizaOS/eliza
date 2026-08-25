/**
 * Relationships plugin contract tests assert action, provider, schema, and view
 * registration without a live database.
 */
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
    // Personal Assistant owns ENTITY, so this plugin must not collide with it.
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

  it("developer-gates the relationships view (empty in the MVP, #14479/#14356)", () => {
    // The graph renders empty for a fresh user, so the view is developer-gated in
    // BOTH the launcher and the manager grid — hidden until Developer Mode is on,
    // kept and reachable, not deleted. Declaring `system` here would leak it into
    // the fresh-user manager grid while the launcher hid it (the divergence #14356
    // closed).
    const view = relationshipsPlugin.views?.find(
      (v) => v.id === "relationships",
    );
    expect(view?.viewKind).toBe("developer");
    expect(view?.visibleInManager).toBe(true);
  });
});
