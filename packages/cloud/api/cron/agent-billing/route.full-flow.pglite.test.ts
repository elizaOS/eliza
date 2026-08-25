/**
 * End-to-end database proof for the scheduled agent-billing path. This suite
 * deliberately uses the real billing and run repositories; run it in its own
 * Bun process so module mocks from the receipt-focused route suite cannot leak.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.TEST_DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import {
  agentBillingRecords,
  agentBillingRunItems,
  agentBillingRuns,
} from "@/db/schemas/compute-billing";
import { computeBillingRateSegments } from "@/db/schemas/compute-billing-rate-segments";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { organizations } from "@/db/schemas/organizations";
import { userCharacters } from "@/db/schemas/user-characters";
import { users } from "@/db/schemas/users";
import {
  makeCronHandler,
  scheduledCronInvocationId,
} from "@/lib/cron/cloudflare-cron";
import type { Bindings } from "@/types/cloud-worker-env";
import { dispatchFullApp } from "../../src/index";
import route from "./route";

const PATH = "/api/cron/agent-billing";
const SCHEDULE = "0 * * * *";
const SCHEDULED_TIME = Date.UTC(2026, 7, 20, 19, 0, 0);
const CRON_SECRET = "full-flow-cron-secret";
const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

function mountRoute(): Hono {
  const app = new Hono();
  app.route(PATH, route);
  return app;
}

async function dispatchScheduledBilling(app: Hono): Promise<Response> {
  let routeResponse: Response | null = null;
  const pending: Promise<unknown>[] = [];
  const scheduled = makeCronHandler(async (request, env, ctx) => {
    if (new URL(request.url).pathname !== PATH) {
      return new Response(null, { status: 204 });
    }
    routeResponse = await dispatchFullApp(
      request,
      env,
      ctx,
      async () => app as never,
    );
    return routeResponse;
  });
  await scheduled(
    { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
    {
      CRON_SECRET,
      NEXT_PUBLIC_APP_URL: "http://internal",
    } as Bindings,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
    } as never,
  );
  await Promise.all(pending);
  if (!routeResponse)
    throw new Error("Scheduled agent-billing route did not run");
  return routeResponse;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-billing full-flow] DATABASE_URL is not isolated PGlite; refusing to mutate it.",
    );
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        creditTransactions,
        agentBillingRecords,
        agentBillingRuns,
        agentBillingRunItems,
        computeBillingRateSegments,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    // error-policy:J1 isolated test-harness setup boundary; dependent tests
    // fail through the explicit readiness assertion with this diagnostic.
    pgliteReady = false;
    console.error(
      "[agent-billing full-flow] PGlite schema setup failed",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(computeBillingRateSegments);
  await dbWrite.delete(agentBillingRunItems);
  await dbWrite.delete(agentBillingRuns);
  await dbWrite.delete(agentBillingRecords);
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent billing scheduled full flow on PGlite", () => {
  test("replays one scheduler identity without a second debit or receipt", async () => {
    const [organization] = await dbWrite
      .insert(organizations)
      .values({
        name: "Full Flow Billing",
        slug: `full-flow-${crypto.randomUUID()}`,
        credit_balance: "10.000000",
        billing_email: "billing@example.test",
        pay_as_you_go_from_earnings: false,
      })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `steward-${crypto.randomUUID()}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: "full-flow-agent",
        status: "running",
        execution_tier: "dedicated-always",
        billing_status: "active",
        last_billed_at: sql`clock_timestamp() - INTERVAL '1 hour'`,
      })
      .returning();
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: organization.id,
      workload_kind: "agent",
      workload_id: sandbox.id,
      lifecycle_revision: sandbox.lifecycle_revision,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: sandbox.last_billed_at!,
    });

    const app = mountRoute();
    const first = await dispatchScheduledBilling(app);
    const replay = await dispatchScheduledBilling(app);
    const firstBody = (await first.json()) as {
      data: { replayed: boolean; totalRevenue: string; results?: unknown[] };
    };
    const replayBody = (await replay.json()) as {
      data: { replayed: boolean; totalRevenue: string; results?: unknown[] };
    };

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      replayed: false,
      totalRevenue: "0.010000",
    });
    expect(firstBody.data.results).toHaveLength(1);
    expect(replayBody.data).toMatchObject({
      replayed: true,
      totalRevenue: "0.010000",
    });
    expect(replayBody.data.results).toBeUndefined();

    const [balance] = await dbWrite
      .select({ creditBalance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    const transactions = await dbWrite.select().from(creditTransactions);
    const billingReceipts = await dbWrite.select().from(agentBillingRecords);
    const runItems = await dbWrite.select().from(agentBillingRunItems);
    const runs = await dbWrite.select().from(agentBillingRuns);

    expect(balance?.creditBalance).toBe("9.990000");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      organization_id: organization.id,
      amount: "-0.010000",
      type: "debit",
    });
    expect(billingReceipts).toHaveLength(1);
    expect(runItems).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runItems[0]).toMatchObject({
      run_id: runs[0]!.id,
      sandbox_id: sandbox.id,
      action: "billed",
      amount: "0.010000",
      transaction_id: transactions[0]!.id,
    });
    expect(billingReceipts[0]).toMatchObject({
      organization_id: organization.id,
      sandbox_id: sandbox.id,
      amount: "0.010000",
      credit_transaction_id: transactions[0]!.id,
    });
    expect(runs[0]).toMatchObject({
      invocation_key: scheduledCronInvocationId(
        { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
        PATH,
      ),
      status: "succeeded",
      sandboxes_processed: 1,
      sandboxes_billed: 1,
      total_revenue: "0.010000",
      attempt_count: 1,
    });
    expect(runs[0]!.duration_ms).toBe(
      runs[0]!.completed_at!.getTime() - runs[0]!.started_at.getTime(),
    );
  });
});
