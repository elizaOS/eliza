/**
 * PGlite check that getTransactionHistory applies `offset` when filtering by
 * `type`. The type-filtered branch used to drop the offset, so a client paging
 * with `type` got the first page back on every request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";

const PGLITE_DATABASE_URL = "pglite://memory";
const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  MOCK_REDIS: process.env.MOCK_REDIS,
  SKIP_AGENT_SANDBOX_ENSURE: process.env.SKIP_AGENT_SANDBOX_ENSURE,
};
// Force both selectors before the client is imported so an ambient
// integration DSN can never receive this suite's DDL.
process.env.DATABASE_URL = PGLITE_DATABASE_URL;
process.env.TEST_DATABASE_URL = PGLITE_DATABASE_URL;
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { appEarningsTransactions } from "../../../db/schemas/app-earnings";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";

type ClientModule = typeof import("../../../db/client");
type ServiceModule = typeof import("../app-earnings");

const ORGANIZATION_ID = "10000000-0000-4000-8000-0000000000e1";
const USER_ID = "20000000-0000-4000-8000-0000000000e1";
const APP_ID = "30000000-0000-4000-8000-0000000000e1";
const WITHDRAWAL_OLDEST = "40000000-0000-4000-8000-000000000001";
const WITHDRAWAL_MIDDLE = "40000000-0000-4000-8000-000000000002";
const WITHDRAWAL_NEWEST = "40000000-0000-4000-8000-000000000003";
const INFERENCE_NEWER = "40000000-0000-4000-8000-000000000004";

let closeDatabaseConnectionsForTests: ClientModule["closeDatabaseConnectionsForTests"] | undefined;
let service: ServiceModule["appEarningsService"];
let schemaFailure = "";

beforeAll(async () => {
  try {
    const [clientModule, serviceModule] = await Promise.all([
      import("../../../db/client"),
      import("../app-earnings"),
    ]);
    const { dbWrite } = clientModule;
    closeDatabaseConnectionsForTests = clientModule.closeDatabaseConnectionsForTests;
    service = serviceModule.appEarningsService;
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        appDeploymentStatusEnum,
        userDatabaseStatusEnum,
        appReviewStatusEnum,
        apps,
        appEarningsTransactions,
      } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite.insert(organizations).values({
      id: ORGANIZATION_ID,
      name: "Earnings org",
      slug: "earnings-org",
    });
    await dbWrite.insert(users).values({
      id: USER_ID,
      steward_user_id: "earnings-user",
      organization_id: ORGANIZATION_ID,
    });
    await dbWrite.insert(apps).values({
      id: APP_ID,
      name: "Earnings app",
      slug: "earnings-app",
      organization_id: ORGANIZATION_ID,
      created_by_user_id: USER_ID,
      app_url: "https://earnings.example.com",
    });
    await dbWrite.insert(appEarningsTransactions).values([
      {
        id: WITHDRAWAL_OLDEST,
        app_id: APP_ID,
        type: "withdrawal",
        amount: "-1.000000",
        created_at: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: WITHDRAWAL_MIDDLE,
        app_id: APP_ID,
        type: "withdrawal",
        amount: "-2.000000",
        created_at: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: WITHDRAWAL_NEWEST,
        app_id: APP_ID,
        type: "withdrawal",
        amount: "-3.000000",
        created_at: new Date("2026-01-03T00:00:00Z"),
      },
      {
        id: INFERENCE_NEWER,
        app_id: APP_ID,
        type: "inference_markup",
        amount: "4.000000",
        created_at: new Date("2026-01-04T00:00:00Z"),
      },
    ]);
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, 120_000);

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function ids(
  options: Parameters<ServiceModule["appEarningsService"]["getTransactionHistory"]>[1],
) {
  const { transactions } = await service.getTransactionHistory(APP_ID, options);
  return transactions.map((row) => row.id);
}

describe("appEarningsService.getTransactionHistory with type and offset", () => {
  test("schema pushed", () => {
    expect(schemaFailure).toBe("");
  });

  test("type-filtered pages advance with offset", async () => {
    expect(await ids({ type: "withdrawal", limit: 1, offset: 0 })).toEqual([WITHDRAWAL_NEWEST]);
    expect(await ids({ type: "withdrawal", limit: 1, offset: 1 })).toEqual([WITHDRAWAL_MIDDLE]);
    expect(await ids({ type: "withdrawal", limit: 1, offset: 2 })).toEqual([WITHDRAWAL_OLDEST]);
    expect(await ids({ type: "withdrawal", limit: 1, offset: 3 })).toEqual([]);
    expect(await ids({ type: "withdrawal", limit: 2, offset: 1 })).toEqual([
      WITHDRAWAL_MIDDLE,
      WITHDRAWAL_OLDEST,
    ]);
  });

  test("unfiltered paging is unchanged", async () => {
    expect(await ids({ limit: 2, offset: 0 })).toEqual([INFERENCE_NEWER, WITHDRAWAL_NEWEST]);
    expect(await ids({ limit: 2, offset: 2 })).toEqual([WITHDRAWAL_MIDDLE, WITHDRAWAL_OLDEST]);
    expect(await ids({})).toEqual([
      INFERENCE_NEWER,
      WITHDRAWAL_NEWEST,
      WITHDRAWAL_MIDDLE,
      WITHDRAWAL_OLDEST,
    ]);
  });
});
