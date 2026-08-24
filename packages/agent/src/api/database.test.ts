/**
 * Real-PGlite unit coverage for the database API's status, table discovery,
 * row browsing, CRUD, and raw-query routes through the production handler.
 */

import type http from "node:http";
import { PassThrough } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import type { AgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleDatabaseRoute } from "./database.ts";

type RecordedResponse = http.ServerResponse & {
  body: string;
  headers: Record<string, string | number | readonly string[]>;
};

function responseRecorder(): RecordedResponse {
  return {
    statusCode: 200,
    body: "",
    headers: {},
    setHeader(
      this: RecordedResponse,
      name: string,
      value: string | number | readonly string[],
    ) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(this: RecordedResponse, chunk?: unknown) {
      if (chunk !== undefined) this.body += String(chunk);
      return this;
    },
  } as unknown as RecordedResponse;
}

function request(
  method: string,
  path: string,
  body?: unknown,
): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = {
    host: "localhost",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  };
  if (body === undefined) {
    req.push(null);
  } else {
    req.push(JSON.stringify(body));
    req.push(null);
  }
  return req;
}

describe("database API with real PGlite", () => {
  let pglite: PGlite;
  let runtime: AgentRuntime;

  async function callRoute(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{
    handled: boolean;
    status: number;
    data: Record<string, unknown> | null;
  }> {
    const res = responseRecorder();
    const pathname = new URL(path, "http://localhost").pathname;
    const handled = await handleDatabaseRoute(
      request(method, path, body),
      res,
      runtime,
      pathname,
    );
    return {
      handled,
      status: res.statusCode,
      data: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : null,
    };
  }

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.waitReady;
    runtime = {
      adapter: { db: drizzle(pglite) },
    } as unknown as AgentRuntime;

    await pglite.exec(`
      CREATE TABLE widgets (
        id SERIAL PRIMARY KEY,
        label TEXT NOT NULL,
        score INTEGER NOT NULL,
        note TEXT,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        payload JSONB
      );
      CREATE TABLE empty_items (
        id SERIAL PRIMARY KEY,
        label TEXT NOT NULL
      );
    `);
  });

  beforeEach(async () => {
    await pglite.exec(`
      TRUNCATE TABLE widgets, empty_items RESTART IDENTITY;
      INSERT INTO widgets (label, score, note, active, payload) VALUES
        ('alpha', 10, NULL, TRUE, '{"rank":1}'::jsonb),
        ('beta', 30, 'second', TRUE, '{"rank":2}'::jsonb),
        ('gamma', 20, NULL, TRUE, '{"rank":3}'::jsonb),
        ('literal%_match', 40, NULL, TRUE, '{"rank":4}'::jsonb),
        ('literalXXmatch', 50, NULL, TRUE, '{"rank":5}'::jsonb);
    `);
  });

  afterAll(async () => {
    await pglite.close();
  });

  it("reports a connected PGlite status from live queries", async () => {
    const previousPostgresUrl = process.env.POSTGRES_URL;
    delete process.env.POSTGRES_URL;

    try {
      const result = await callRoute("GET", "/api/database/status");

      expect(result).toMatchObject({ handled: true, status: 200 });
      expect(result.data).toMatchObject({
        provider: "pglite",
        connected: true,
        tableCount: 2,
        postgresHost: null,
      });
      expect(result.data?.serverVersion).toEqual(expect.any(String));
    } finally {
      if (previousPostgresUrl === undefined) {
        delete process.env.POSTGRES_URL;
      } else {
        process.env.POSTGRES_URL = previousPostgresUrl;
      }
    }
  });

  it("discovers populated and empty tables with real column metadata", async () => {
    const result = await callRoute("GET", "/api/database/tables");

    expect(result).toMatchObject({ handled: true, status: 200 });
    const tables = result.data?.tables as Array<{
      name: string;
      schema: string;
      columns: Array<Record<string, unknown>>;
    }>;
    expect(tables.map((table) => table.name)).toEqual([
      "empty_items",
      "widgets",
    ]);
    expect(tables.find((table) => table.name === "empty_items")).toMatchObject({
      schema: "public",
      columns: [
        {
          name: "id",
          type: "integer",
          nullable: false,
          isPrimaryKey: true,
        },
        {
          name: "label",
          type: "text",
          nullable: false,
          isPrimaryKey: false,
        },
      ],
    });
  });

  it("returns the complete empty-table shape", async () => {
    const result = await callRoute(
      "GET",
      "/api/database/tables/empty_items/rows",
    );

    expect(result).toEqual({
      handled: true,
      status: 200,
      data: {
        table: "empty_items",
        rows: [],
        columns: ["id", "label"],
        total: 0,
        offset: 0,
        limit: 50,
      },
    });
  });

  it("sorts and paginates populated rows", async () => {
    const result = await callRoute(
      "GET",
      "/api/database/tables/widgets/rows?sort=score&order=desc&offset=1&limit=2",
    );

    expect(result).toMatchObject({
      handled: true,
      status: 200,
      data: {
        table: "widgets",
        total: 5,
        offset: 1,
        limit: 2,
        rows: [{ label: "literal%_match" }, { label: "beta" }],
      },
    });
  });

  it("treats percent and underscore in search input as literals", async () => {
    const result = await callRoute(
      "GET",
      "/api/database/tables/widgets/rows?search=literal%25_",
    );

    expect(result).toMatchObject({
      handled: true,
      status: 200,
      data: {
        total: 1,
        rows: [{ label: "literal%_match" }],
      },
    });
  });

  it("inserts quoted strings, nulls, and JSON through the row route", async () => {
    const result = await callRoute(
      "POST",
      "/api/database/tables/widgets/rows",
      {
        data: {
          label: "O'Reilly",
          score: 60,
          note: null,
          active: false,
          payload: { text: "can't" },
        },
      },
    );

    expect(result).toMatchObject({
      handled: true,
      status: 201,
      data: {
        inserted: true,
        row: {
          label: "O'Reilly",
          score: 60,
          note: null,
          active: false,
          payload: { text: "can't" },
        },
      },
    });
    const persisted = await pglite.query(
      "SELECT label, score, note, active, payload FROM widgets WHERE score = 60",
    );
    expect(persisted.rows).toEqual([
      {
        label: "O'Reilly",
        score: 60,
        note: null,
        active: false,
        payload: { text: "can't" },
      },
    ]);
  });

  it("updates through null predicates and returns 404 for a missing row", async () => {
    const updated = await callRoute(
      "PUT",
      "/api/database/tables/widgets/rows",
      {
        where: { label: "alpha", note: null },
        data: { label: "updated", active: false, payload: { rank: 9 } },
      },
    );
    const missing = await callRoute(
      "PUT",
      "/api/database/tables/widgets/rows",
      {
        where: { id: 9999 },
        data: { label: "never-written" },
      },
    );

    expect(updated).toMatchObject({
      handled: true,
      status: 200,
      data: {
        updated: true,
        row: {
          label: "updated",
          note: null,
          active: false,
          payload: { rank: 9 },
        },
      },
    });
    expect(missing).toEqual({
      handled: true,
      status: 404,
      data: { error: "No matching row found to update." },
    });
  });

  it("deletes a matching row and preserves state when the row is missing", async () => {
    const missing = await callRoute(
      "DELETE",
      "/api/database/tables/widgets/rows",
      { where: { id: 9999 } },
    );
    const deleted = await callRoute(
      "DELETE",
      "/api/database/tables/widgets/rows",
      { where: { label: "beta" } },
    );

    expect(missing).toEqual({
      handled: true,
      status: 404,
      data: { error: "No matching row found to delete." },
    });
    expect(deleted).toMatchObject({
      handled: true,
      status: 200,
      data: { deleted: true, row: { label: "beta", score: 30 } },
    });
    const remaining = await pglite.query(
      "SELECT label FROM widgets ORDER BY id",
    );
    expect(remaining.rows).toEqual([
      { label: "alpha" },
      { label: "gamma" },
      { label: "literal%_match" },
      { label: "literalXXmatch" },
    ]);
  });

  it("executes read-only queries and explicit mutations against the live store", async () => {
    const selected = await callRoute("POST", "/api/database/query", {
      sql: "SELECT label, score FROM widgets WHERE score >= 40 ORDER BY score DESC",
    });
    const inserted = await callRoute("POST", "/api/database/query", {
      sql: "INSERT INTO widgets (label, score) VALUES ('raw', 70) RETURNING label, score",
      readOnly: false,
    });

    expect(selected).toMatchObject({
      handled: true,
      status: 200,
      data: {
        columns: ["label", "score"],
        rowCount: 2,
        rows: [
          { label: "literalXXmatch", score: 50 },
          { label: "literal%_match", score: 40 },
        ],
      },
    });
    expect(inserted).toMatchObject({
      handled: true,
      status: 200,
      data: {
        columns: ["label", "score"],
        rowCount: 1,
        rows: [{ label: "raw", score: 70 }],
      },
    });
    await expect(
      pglite.query("SELECT label FROM widgets WHERE score = 70"),
    ).resolves.toMatchObject({ rows: [{ label: "raw" }] });
  });

  it("rejects empty mutations before touching the database", async () => {
    const insert = await callRoute(
      "POST",
      "/api/database/tables/widgets/rows",
      { data: {} },
    );
    const update = await callRoute("PUT", "/api/database/tables/widgets/rows", {
      where: {},
      data: { label: "x" },
    });
    const remove = await callRoute(
      "DELETE",
      "/api/database/tables/widgets/rows",
      { where: {} },
    );

    expect(insert).toMatchObject({ status: 400 });
    expect(update).toMatchObject({ status: 400 });
    expect(remove).toMatchObject({ status: 400 });
    await expect(
      pglite.query("SELECT count(*) AS total FROM widgets"),
    ).resolves.toMatchObject({ rows: [{ total: 5 }] });
  });

  it("returns false for an unmatched route when an adapter is available", async () => {
    await expect(
      callRoute("GET", "/api/database/not-a-route"),
    ).resolves.toEqual({
      handled: false,
      status: 200,
      data: null,
    });
  });
});
