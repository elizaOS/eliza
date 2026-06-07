import { describe, expect, it } from "vitest";

import { entityAction } from "./actions/entity.js";
import {
  entitiesTable,
  relationshipsSchema,
  relationshipsTable,
} from "./db/schema.js";
import { relationshipsPlugin } from "./plugin.js";
import { entityGraphProvider } from "./providers/entity-graph.js";

describe("@elizaos/plugin-relationships scaffold", () => {
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

  it("keeps the ENTITY stub safe until the full port lands", async () => {
    const result = await entityAction.handler(
      {} as never,
      {} as never,
      undefined,
      { parameters: { action: "set_relationship" } },
      undefined,
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("ENTITY action stub");
    expect(result.data).toEqual({ todo: true, op: "set_relationship" });
  });

  it("provides an empty graph projection while the store is scaffolded", async () => {
    const result = await entityGraphProvider.get({} as never, {} as never);

    expect(result).toEqual({
      text: "",
      data: { entities: [], relationships: [] },
    });
  });
});
