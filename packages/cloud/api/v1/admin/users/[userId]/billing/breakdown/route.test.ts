import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { usageRecords } from "@elizaos/cloud-shared/db/schemas/usage-records";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";

const client = new PGlite();
const database = drizzle({ client, schema: { usageRecords } });

mock.module("@elizaos/cloud-shared/db/helpers", () => ({
  db: database,
  dbRead: database,
  dbWrite: database,
}));
mock.module("@elizaos/cloud-shared/lib/auth/admin", () => ({
  requireAdminWithResponse: async () => ({
    user: { id: "admin" },
    role: "super_admin",
  }),
}));

const { default: breakdownRoute }: { default: Hono<AppEnv> } = await import(
  "./route"
);

const USER_ID = "22222222-2222-4222-8222-222222222222";

const app = new Hono<AppEnv>();
app.route("/api/v1/admin/users/:userId/billing/breakdown", breakdownRoute);

describe("GET /api/v1/admin/users/:userId/billing/breakdown", () => {
  beforeAll(async () => {
    await client.exec(`
      create table usage_records (
        user_id uuid,
        type text not null,
        provider text not null,
        input_cost numeric default 0,
        output_cost numeric default 0,
        markup numeric default 0,
        created_at timestamp not null default now()
      );
    `);
    await client.query(
      `insert into usage_records (user_id, type, provider, input_cost, output_cost, markup)
       values ($1, 'chat', 'openai', 1.2, 0.6, 0.3),
              ($1, 'tts', 'elevenlabs', 0.12, 0, 0.02)`,
      [USER_ID],
    );
  });

  afterAll(async () => {
    await client.close();
  });

  test("reports billed cost as the recorded charge and raw cost without the platform markup", async () => {
    const response = await app.request(
      `/api/v1/admin/users/${USER_ID}/billing/breakdown`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      breakdown: Array<{
        type: string;
        rawCost: number;
        markup: number;
        billedCost: number;
      }>;
      totals: { rawCost: number; markup: number; billedCost: number };
    };

    const rounded = (value: number) => Math.round(value * 1e6) / 1e6;
    expect(
      body.breakdown.map((row) => ({
        type: row.type,
        rawCost: rounded(row.rawCost),
        markup: rounded(row.markup),
        billedCost: rounded(row.billedCost),
      })),
    ).toEqual([
      { type: "chat", rawCost: 1.5, markup: 0.3, billedCost: 1.8 },
      { type: "tts", rawCost: 0.1, markup: 0.02, billedCost: 0.12 },
    ]);
    expect({
      rawCost: rounded(body.totals.rawCost),
      markup: rounded(body.totals.markup),
      billedCost: rounded(body.totals.billedCost),
    }).toEqual({ rawCost: 1.6, markup: 0.32, billedCost: 1.92 });
  });
});
