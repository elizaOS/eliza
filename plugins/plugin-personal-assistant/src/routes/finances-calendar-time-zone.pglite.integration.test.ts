/**
 * Both advertised bill surfaces, the FINANCES action (`dashboard`) and
 * `GET /api/lifeops/money/bills`, classify dueness on the owner's calendar
 * day and fail closed together (#31062). Real harness: the normally
 * registered personal-assistant plugin on a PGlite runtime supplies the
 * calendar time zone resolver from the owner facts, the bill is persisted
 * through the finances plugin schema, and the route is reached through the
 * real runtime plugin HTTP dispatcher. Only `Date` is faked, to pin `now`.
 */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { HandlerOptions, Memory } from "@elizaos/core";
import { runPaymentsHandler } from "@elizaos/plugin-finances/actions/finances";
import { FinancesService } from "@elizaos/plugin-finances/finances-service";
import { financesPlugin } from "@elizaos/plugin-finances/plugin";
import {
  CALENDAR_TIME_ZONE_INVALID,
  resolveCalendarTimeZone,
} from "@elizaos/shared";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { resolveOwnerFactStore } from "../lifeops/owner/fact-store.js";

// Evening of March 2 in the Americas, afternoon of March 3 in Tokyo.
const NOW = new Date("2026-03-03T03:30:00.000Z");
const DUE_DATE = "2026-03-02";

interface BillView {
  id: string;
  dueDate: string | null;
  status: string;
}

describe("finances bill dueness through both surfaces (#31062)", () => {
  let host: RealTestRuntimeResult;
  let server: Server;
  let base: string;
  let billId: string;
  let previousSchedulerFlag: string | undefined;

  beforeAll(async () => {
    // The LifeOps scheduler tick reconciles owner travel: a home zone that
    // differs from the host zone opens a provisional travel record whose
    // destination (the host zone) then legitimately overrides the owner zone.
    // The zone fixtures below must stay the effective zone, so the tick is
    // disabled for this runtime.
    previousSchedulerFlag = process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = "1";
    host = await createLifeOpsTestRuntime({
      characterName: "finances-calendar-time-zone",
      plugins: [financesPlugin],
    });
    const runtime = host.runtime;
    const inserted = await new FinancesService(runtime).upsertBillFromEmail({
      sourceMessageId: "gmail-water-1",
      merchant: "Water Utility",
      amountUsd: 42.5,
      currency: "USD",
      dueDate: DUE_DATE,
      confidence: 0.9,
    });
    billId = inserted.transactionId;
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await tryHandleRuntimePluginRoute({
        req,
        res,
        url,
        pathname: url.pathname,
        method: req.method ?? "GET",
        runtime,
        isAuthorized: () => true,
      });
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server omitted bound TCP address");
    }
    base = `http://127.0.0.1:${address.port}`;
  }, 180_000);

  // The shared app-core setup restores real timers after every test, so the
  // pinned instant is re-armed per test rather than once for the file.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    await host?.cleanup();
    if (previousSchedulerFlag === undefined) {
      delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    } else {
      process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER = previousSchedulerFlag;
    }
  });

  async function setOwnerTimeZone(timezone: string): Promise<void> {
    const store = resolveOwnerFactStore(host.runtime);
    const provenance = {
      source: "profile_save" as const,
      recordedAt: NOW.toISOString(),
    };
    await store.setActiveTravel(null, provenance);
    await store.update({ timezone }, provenance);
  }

  async function actionBill() {
    const message: Memory = {
      entityId: host.runtime.agentId,
      roomId: host.runtime.agentId,
      content: { text: "" },
    };
    const result = await runPaymentsHandler(host.runtime, message, undefined, {
      parameters: { subaction: "dashboard" },
    } as HandlerOptions);
    if (!result.success) return { result, bill: null };
    const dashboard = (
      result.data as { dashboard: { upcomingBills: BillView[] } }
    ).dashboard;
    const bill = dashboard.upcomingBills.find((entry) => entry.id === billId);
    if (!bill) throw new Error("seeded bill missing from dashboard");
    return { result, bill };
  }

  async function routeBill() {
    const response = await fetch(`${base}/api/lifeops/money/bills`);
    if (response.status !== 200) {
      return {
        status: response.status,
        body: await response.json(),
        bill: null,
      };
    }
    const body = (await response.json()) as { bills: BillView[] };
    const bill = body.bills.find((entry) => entry.id === billId);
    if (!bill) throw new Error("seeded bill missing from route response");
    return { status: response.status, body, bill };
  }

  it("registers the owner-fact calendar zone resolver through plugin init", async () => {
    await setOwnerTimeZone("America/Los_Angeles");
    expect(await resolveCalendarTimeZone(host.runtime, NOW)).toEqual({
      timeZone: "America/Los_Angeles",
      source: "owner",
    });
  });

  it("keeps a bill due today in the owner's zone upcoming on both surfaces", async () => {
    await setOwnerTimeZone("America/Los_Angeles");
    const viaAction = await actionBill();
    const viaRoute = await routeBill();
    expect(viaAction.result.success).toBe(true);
    expect(viaAction.bill).toMatchObject({
      dueDate: DUE_DATE,
      status: "upcoming",
    });
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.bill).toMatchObject({
      dueDate: DUE_DATE,
      status: "upcoming",
    });
  });

  it("marks the same bill overdue on both surfaces once the owner is in Tokyo", async () => {
    await setOwnerTimeZone("Asia/Tokyo");
    const viaAction = await actionBill();
    const viaRoute = await routeBill();
    expect(viaAction.bill).toMatchObject({ status: "overdue" });
    expect(viaRoute.bill).toMatchObject({ status: "overdue" });
  });

  it("surfaces an invalid owner zone as an error on both surfaces instead of reclassifying", async () => {
    await setOwnerTimeZone("Mars/Phobos");
    const viaAction = await actionBill();
    expect(viaAction.result.success).toBe(false);
    expect(viaAction.result.data).toMatchObject({
      status: 422,
      code: CALENDAR_TIME_ZONE_INVALID,
    });
    const viaRoute = await routeBill();
    expect(viaRoute.status).toBe(422);
    expect(viaRoute.bill).toBeNull();
    expect(JSON.stringify(viaRoute.body)).toContain("Mars/Phobos");
  });
});
