/**
 * Exercises the shared turn traces repository's tenant scoping with scripted
 * client mocks (no database): the recent-traces read must pin BOTH
 * organization_id and agent_id in its WHERE clause — agent ids are
 * caller-supplied text and the table has no FK back to tenant tables, so this
 * SQL pin is the only cross-tenant read barrier — and the insert must carry
 * the full org/user/agent scope it was handed.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as realClient from "../client";

const ORG_ID = "0b6f9dd2-6a2f-4d55-b552-8f4f7bfb9f01";
const AGENT_ID = "agent-under-test";

// Scripted read chain: capture the WHERE clause and limit handed to the builder.
let capturedWhere: SQL | undefined;
let capturedLimit: number | undefined;
const listRows = [{ id: "row-1" }, { id: "row-2" }];
const limitFn = mock((n: number) => {
  capturedLimit = n;
  return Promise.resolve(listRows);
});
const orderByFn = mock(() => ({ limit: limitFn }));
const whereFn = mock((clause: SQL) => {
  capturedWhere = clause;
  return { orderBy: orderByFn };
});
const fromFn = mock(() => ({ where: whereFn }));
const selectFn = mock(() => ({ from: fromFn }));
const dbReadMock = new Proxy(realClient.dbRead as unknown as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "select") return selectFn;
    return Reflect.get(target, prop, receiver);
  },
});

// Scripted write chain: capture the values object handed to insert().values().
let capturedValues: Record<string, unknown> | undefined;
const valuesFn = mock((values: Record<string, unknown>) => {
  capturedValues = values;
  return Promise.resolve();
});
const insertFn = mock(() => ({ values: valuesFn }));
const dbWriteMock = new Proxy(realClient.dbWrite as unknown as Record<PropertyKey, unknown>, {
  get(target, prop, receiver) {
    if (prop === "insert") return insertFn;
    return Reflect.get(target, prop, receiver);
  },
});

mock.module("../client", () => ({
  ...realClient,
  dbRead: dbReadMock,
  dbWrite: dbWriteMock,
}));

afterAll(() => {
  mock.module("../client", () => realClient);
});

describe("SharedTurnTracesRepository.listRecentByAgent", () => {
  test("pins organization_id AND agent_id in the WHERE clause and caps the limit", async () => {
    capturedWhere = undefined;
    capturedLimit = undefined;
    const { SharedTurnTracesRepository } = await import("./shared-turn-traces");

    const rows = await new SharedTurnTracesRepository().listRecentByAgent(ORG_ID, AGENT_ID, 25);

    expect(rows).toEqual(listRows as never);
    expect(selectFn).toHaveBeenCalledTimes(1);
    expect(capturedLimit).toBe(25);

    if (!capturedWhere) throw new Error("WHERE clause was not captured");
    const sql = new PgDialect().sqlToQuery(capturedWhere);
    // Both tenant pins must be present: org alone would mix an org's agents up
    // only by caller honesty; agent alone would leak across organizations.
    expect(sql.sql).toContain("organization_id");
    expect(sql.sql).toContain("agent_id");
    expect(sql.params).toContain(ORG_ID);
    expect(sql.params).toContain(AGENT_ID);
  });

  test("clamps a hostile or absurd limit into the bounded page window", async () => {
    const { SharedTurnTracesRepository } = await import("./shared-turn-traces");
    const repository = new SharedTurnTracesRepository();

    capturedLimit = undefined;
    await repository.listRecentByAgent(ORG_ID, AGENT_ID, 1_000_000);
    expect(capturedLimit).toBe(200);

    capturedLimit = undefined;
    await repository.listRecentByAgent(ORG_ID, AGENT_ID, -5);
    expect(capturedLimit).toBe(1);

    capturedLimit = undefined;
    await repository.listRecentByAgent(ORG_ID, AGENT_ID, Number.NaN);
    expect(capturedLimit).toBe(1);
  });
});

describe("SharedTurnTracesRepository.insertTrace", () => {
  test("writes the row with its full org/user/agent scope and jsonb payloads", async () => {
    capturedValues = undefined;
    const { SharedTurnTracesRepository } = await import("./shared-turn-traces");

    await new SharedTurnTracesRepository().insertTrace({
      organization_id: ORG_ID,
      user_id: "4e2ffab7-9f21-4a2c-92b7-33dd25c7f8a2",
      agent_id: AGENT_ID,
      channel_id: "shared:agent:room",
      trace_id: "trace-1",
      started_at: new Date(1_787_860_800_000),
      latency_ms: 812,
      model: "gemma-4-31b",
      usage: { inputTokens: 12 },
      stages: { finishReason: "reply", stages: [{ name: "model" }] },
    });

    expect(insertFn).toHaveBeenCalledTimes(1);
    if (!capturedValues) throw new Error("insert values were not captured");
    expect(capturedValues.organization_id).toBe(ORG_ID);
    expect(capturedValues.user_id).toBe("4e2ffab7-9f21-4a2c-92b7-33dd25c7f8a2");
    expect(capturedValues.agent_id).toBe(AGENT_ID);
    expect(capturedValues.trace_id).toBe("trace-1");
    // jsonb columns are bound through jsonbParam (explicit ::jsonb SQL params).
    const usageSql = new PgDialect().sqlToQuery(capturedValues.usage as SQL);
    expect(usageSql.sql).toContain("::jsonb");
    expect(usageSql.params).toContain(JSON.stringify({ inputTokens: 12 }));
    const stagesSql = new PgDialect().sqlToQuery(capturedValues.stages as SQL);
    expect(stagesSql.sql).toContain("::jsonb");
    expect(stagesSql.params).toContain(
      JSON.stringify({ finishReason: "reply", stages: [{ name: "model" }] }),
    );
  });
});
