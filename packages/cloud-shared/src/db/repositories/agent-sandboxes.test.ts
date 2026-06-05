import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

let capturedWhere: SQL | undefined;

const returning = mock(() => [
  {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    status: "provisioning",
  },
]);
const where = mock((clause: SQL) => {
  capturedWhere = clause;
  return { returning };
});
const set = mock(() => ({ where }));
const update = mock(() => ({ set }));
const ensureAgentSandboxSchema = mock(async () => {});

mock.module("../helpers", () => ({
  dbRead: {},
  dbWrite: { update },
}));

mock.module("../ensure-agent-sandbox-schema", () => ({
  ensureAgentSandboxSchema,
}));

describe("AgentSandboxesRepository", () => {
  test("allows sleeping agents to take the provisioning lock for wake", async () => {
    capturedWhere = undefined;

    const { AgentSandboxesRepository } = await import("./agent-sandboxes");

    await new AgentSandboxesRepository().trySetProvisioning("e06bb509-6c52-4c33-a9f7-66addc43e8c8");

    expect(ensureAgentSandboxSchema).toHaveBeenCalled();
    if (!capturedWhere) throw new Error("trySetProvisioning did not build a where clause");
    expect(new PgDialect().sqlToQuery(capturedWhere).sql).toContain("'sleeping'");
  });
});
