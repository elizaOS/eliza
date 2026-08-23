/**
 * Exercises `findAgentSandboxRoutingById` as the agent-router's id → ingress
 * lookup. A chainable thenable stands in for `dbRead` so the real module's
 * select/from/where/limit contract can run without loading the full schema
 * barrel. Stored rows keep extra columns; the assertion is the projection
 * the production query actually asked for.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentSandboxes } from "./schemas/agent-sandboxes";

type RoutingRow = {
  id: string;
  status: string;
  bridge_url: string | null;
  bridge_port: number | null;
  headscale_ip: string | null;
  web_ui_port: number | null;
  agent_name?: string;
  billing_status?: string;
};

const dialect = new PgDialect();
const storedRows: RoutingRow[] = [];
let lastProjection: Record<string, unknown> | undefined;
let lastFrom: unknown;
let lastWhere: SQL | undefined;
let lastLimit: number | undefined;

function project(row: RoutingRow, projection: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(projection)) {
    out[key] = row[key as keyof RoutingRow];
  }
  return out;
}

function executeQuery(): Record<string, unknown>[] {
  const compiled = lastWhere ? dialect.sqlToQuery(lastWhere) : { sql: "", params: [] as unknown[] };
  const boundId = compiled.params[0];
  const matched = storedRows.filter((row) => row.id === boundId);
  const projection = lastProjection ?? {};
  const projected = matched.map((row) => project(row, projection));
  if (typeof lastLimit === "number") {
    return projected.slice(0, lastLimit);
  }
  return projected;
}

const query = {
  select(projection: Record<string, unknown>) {
    lastProjection = projection;
    return query;
  },
  from(table: unknown) {
    lastFrom = table;
    return query;
  },
  where(clause: SQL) {
    lastWhere = clause;
    return query;
  },
  limit(n: number) {
    lastLimit = n;
    return query;
  },
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable thenables.
  then(
    resolve: (value: Record<string, unknown>[]) => unknown,
    reject: (reason: unknown) => unknown,
  ) {
    return Promise.resolve()
      .then(() => executeQuery())
      .then(resolve, reject);
  },
};

mock.module("./client", () => ({
  dbRead: {
    select: (projection: Record<string, unknown>) => query.select(projection),
  },
}));

const { findAgentSandboxRoutingById } = await import("./agent-sandbox-routing");

function resetQuery(): void {
  storedRows.length = 0;
  lastProjection = undefined;
  lastFrom = undefined;
  lastWhere = undefined;
  lastLimit = undefined;
}

beforeEach(() => {
  resetQuery();
});

afterAll(() => {
  mock.restore();
});

describe("findAgentSandboxRoutingById", () => {
  test("returns undefined when no sandbox matches the id", async () => {
    const result = await findAgentSandboxRoutingById("00000000-0000-4000-8000-00000000ffff");
    expect(result).toBeUndefined();
    expect(lastFrom).toBe(agentSandboxes);
    expect(lastLimit).toBe(1);
    expect(lastProjection ? Object.keys(lastProjection).sort() : []).toEqual(
      ["bridge_port", "bridge_url", "headscale_ip", "status", "web_ui_port"].sort(),
    );
    const compiled = dialect.sqlToQuery(lastWhere as SQL);
    expect(compiled.sql).toContain("id");
    expect(compiled.params).toEqual(["00000000-0000-4000-8000-00000000ffff"]);
  });

  test("returns undefined after the matching row is removed", async () => {
    storedRows.push({
      id: "11111111-1111-4111-8111-111111111111",
      status: "running",
      bridge_url: "http://100.64.0.8:3000",
      bridge_port: 3000,
      headscale_ip: "100.64.0.8",
      web_ui_port: 8080,
    });

    expect(await findAgentSandboxRoutingById("11111111-1111-4111-8111-111111111111")).toEqual({
      status: "running",
      bridge_url: "http://100.64.0.8:3000",
      bridge_port: 3000,
      headscale_ip: "100.64.0.8",
      web_ui_port: 8080,
    });

    storedRows.length = 0;
    await expect(
      findAgentSandboxRoutingById("11111111-1111-4111-8111-111111111111"),
    ).resolves.toBeUndefined();
  });

  test("projects only the five routing fields from a populated row", async () => {
    storedRows.push({
      id: "22222222-2222-4222-8222-222222222222",
      status: "running",
      bridge_url: "http://100.64.0.1:3000",
      bridge_port: 3000,
      headscale_ip: "100.64.0.1",
      web_ui_port: 8080,
      agent_name: "must-not-leak",
      billing_status: "suspended",
    });

    const row = await findAgentSandboxRoutingById("22222222-2222-4222-8222-222222222222");
    expect(row).toEqual({
      status: "running",
      bridge_url: "http://100.64.0.1:3000",
      bridge_port: 3000,
      headscale_ip: "100.64.0.1",
      web_ui_port: 8080,
    });
    expect(row).not.toHaveProperty("agent_name");
    expect(row).not.toHaveProperty("billing_status");
    expect(row).not.toHaveProperty("id");
    expect(lastLimit).toBe(1);
    expect(lastFrom).toBe(agentSandboxes);
  });

  test("passes through null routing columns on a pending sandbox", async () => {
    storedRows.push({
      id: "33333333-3333-4333-8333-333333333333",
      status: "pending",
      bridge_url: null,
      bridge_port: null,
      headscale_ip: null,
      web_ui_port: null,
    });

    await expect(
      findAgentSandboxRoutingById("33333333-3333-4333-8333-333333333333"),
    ).resolves.toEqual({
      status: "pending",
      bridge_url: null,
      bridge_port: null,
      headscale_ip: null,
      web_ui_port: null,
    });
  });

  test("preserves zero ports as distinct from null", async () => {
    storedRows.push({
      id: "44444444-4444-4444-8444-444444444444",
      status: "stopped",
      bridge_url: null,
      bridge_port: 0,
      headscale_ip: "",
      web_ui_port: 0,
    });

    await expect(
      findAgentSandboxRoutingById("44444444-4444-4444-8444-444444444444"),
    ).resolves.toEqual({
      status: "stopped",
      bridge_url: null,
      bridge_port: 0,
      headscale_ip: "",
      web_ui_port: 0,
    });
  });

  test("selects only the requested id among several sandboxes", async () => {
    storedRows.push(
      {
        id: "55555555-5555-4555-8555-555555555551",
        status: "running",
        bridge_url: null,
        bridge_port: 3001,
        headscale_ip: "100.64.0.1",
        web_ui_port: 8001,
      },
      {
        id: "55555555-5555-4555-8555-555555555552",
        status: "sleeping",
        bridge_url: null,
        bridge_port: 3002,
        headscale_ip: "100.64.0.2",
        web_ui_port: 8002,
      },
      {
        id: "55555555-5555-4555-8555-555555555553",
        status: "deletion_pending",
        bridge_url: null,
        bridge_port: 3003,
        headscale_ip: "100.64.0.3",
        web_ui_port: 8003,
      },
    );

    await expect(
      findAgentSandboxRoutingById("55555555-5555-4555-8555-555555555552"),
    ).resolves.toEqual({
      status: "sleeping",
      bridge_url: null,
      bridge_port: 3002,
      headscale_ip: "100.64.0.2",
      web_ui_port: 8002,
    });
    await expect(
      findAgentSandboxRoutingById("55555555-5555-4555-8555-555555555551"),
    ).resolves.toMatchObject({ status: "running", headscale_ip: "100.64.0.1" });
    await expect(
      findAgentSandboxRoutingById("55555555-5555-4555-8555-555555555553"),
    ).resolves.toMatchObject({ status: "deletion_pending", headscale_ip: "100.64.0.3" });
  });

  test("applies limit 1 when duplicate ids exist in the result set", async () => {
    storedRows.push(
      {
        id: "66666666-6666-4666-8666-666666666666",
        status: "running",
        bridge_url: "http://first",
        bridge_port: 1,
        headscale_ip: "100.64.0.1",
        web_ui_port: 1,
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        status: "stopped",
        bridge_url: "http://second",
        bridge_port: 2,
        headscale_ip: "100.64.0.2",
        web_ui_port: 2,
      },
    );

    await expect(
      findAgentSandboxRoutingById("66666666-6666-4666-8666-666666666666"),
    ).resolves.toEqual({
      status: "running",
      bridge_url: "http://first",
      bridge_port: 1,
      headscale_ip: "100.64.0.1",
      web_ui_port: 1,
    });
    expect(lastLimit).toBe(1);
  });
});
