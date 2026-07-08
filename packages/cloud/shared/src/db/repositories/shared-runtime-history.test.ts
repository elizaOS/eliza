// Exercises cloud DB shared runtime history behavior with deterministic repository fixtures.
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realClient from "../client";

// Capture the generated WHERE clause so we can assert the delete is scoped to a
// single agent (every channel) and never a table-wide wipe.
let capturedWhere: SQL | undefined;

const returning = mock(() => [{ channelId: "c1" }, { channelId: "c2" }]);
const deleteWhere = mock((clause: SQL) => {
  capturedWhere = clause;
  return { returning };
});
const del = mock(() => ({ where: deleteWhere }));
const dbWriteMock = new Proxy(realClient.dbWrite as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "delete") return del;
    return Reflect.get(target, prop, receiver);
  },
});

mock.module("../client", () => ({
  ...realClient,
  dbWrite: dbWriteMock,
}));

afterAll(() => {
  mock.module("../client", () => realClient);
});

describe("SharedRuntimeHistoryRepository.deleteByAgent", () => {
  test("deletes every channel row for the agent and returns the count", async () => {
    capturedWhere = undefined;
    const { SharedRuntimeHistoryRepository } = await import("./shared-runtime-history");

    const removed = await new SharedRuntimeHistoryRepository().deleteByAgent(
      "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    );

    // Two channel rows existed → count reflects the orphaned history actually dropped.
    expect(removed).toBe(2);
    expect(del).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(1);

    // The WHERE must filter on agent_id only (delete-by-agent across all
    // channels), never an unscoped DELETE that would nuke other agents' history.
    if (!capturedWhere) throw new Error("WHERE clause was not captured");
    const sql = new PgDialect().sqlToQuery(capturedWhere);
    expect(sql.sql).toContain("agent_id");
    expect(sql.params).toContain("e06bb509-6c52-4c33-a9f7-66addc43e8c8");
  });
});
