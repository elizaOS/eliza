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
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { runPaymentsHandler } from "@elizaos/plugin-finances/actions/finances";
import { FinancesService } from "@elizaos/plugin-finances/finances-service";
import { financesPlugin } from "@elizaos/plugin-finances/plugin";
import {
  CALENDAR_TIME_ZONE_INVALID,
  resolveCalendarTimeZone,
} from "@elizaos/shared";
import {
  afterAll,
  afterEach,
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
import { LifeOpsService } from "../lifeops/service.js";

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
    vi.stubEnv("TZ", "UTC");
    vi.stubEnv("ELIZA_DEVICE_KIND", "cloud");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // Keep the scheduler enabled; invoke its real public tick deterministically below.
    previousSchedulerFlag = process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
    delete process.env.ELIZA_DISABLE_LIFEOPS_SCHEDULER;
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
    vi.stubEnv("TZ", "UTC");
    vi.stubEnv("ELIZA_DEVICE_KIND", "cloud");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("does not infer owner travel from a UTC cloud host", async () => {
    await setOwnerTimeZone("America/Los_Angeles");
    const before = {
      facts: await resolveOwnerFactStore(host.runtime).read(),
      zone: await resolveCalendarTimeZone(host.runtime, NOW),
      action: await actionBill(),
      route: await routeBill(),
    };
    const service = new LifeOpsService(host.runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(host.runtime),
    });
    const tick = await service.processScheduledWork({
      now: NOW.toISOString(),
      sleepCycleCheckins: false,
    });
    const after = {
      facts: await resolveOwnerFactStore(host.runtime).read(),
      zone: await resolveCalendarTimeZone(host.runtime, NOW),
      action: await actionBill(),
      route: await routeBill(),
    };
    expect(before.zone.timeZone).toBe("America/Los_Angeles");
    expect(before.action.bill?.status).toBe("upcoming");
    expect(before.route.bill?.status).toBe("upcoming");
    expect(
      tick.subsystemFailures.find(
        (failure) => failure.subsystem === "travel_reconcile",
      ),
    ).toBeUndefined();
    expect(after.facts.activeTravel).toBeUndefined();
    expect(after.zone.timeZone).toBe("America/Los_Angeles");
    expect(after.action.bill?.status).toBe("upcoming");
    expect(after.route.bill?.status).toBe("upcoming");
  }, 180_000);

  it("preserves active owner travel on a cloud host", async () => {
    await setOwnerTimeZone("America/Los_Angeles");
    const store = resolveOwnerFactStore(host.runtime);
    const travel = {
      startIso: "2026-03-01T00:00:00.000Z",
      endIso: "2026-03-05T00:00:00.000Z",
      destinationTimezone: "Asia/Tokyo",
    };
    await store.setActiveTravel(travel, {
      source: "profile_save",
      recordedAt: NOW.toISOString(),
    });
    const service = new LifeOpsService(host.runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(host.runtime),
    });
    await service.processScheduledWork({
      now: NOW.toISOString(),
      sleepCycleCheckins: false,
    });
    expect((await store.read()).activeTravel?.value).toEqual(travel);
    expect((await routeBill()).bill?.status).toBe("overdue");
  }, 180_000);

  it("does not treat a cloud host matching home as a device returning home", async () => {
    await setOwnerTimeZone("UTC");
    const store = resolveOwnerFactStore(host.runtime);
    const travel = {
      startIso: "2026-03-01T00:00:00.000Z",
      endIso: "2026-03-05T00:00:00.000Z",
      destinationTimezone: "Asia/Tokyo",
    };
    await store.setActiveTravel(travel, {
      source: "connector_inferred",
      recordedAt: NOW.toISOString(),
      note: "device-timezone divergence",
    });
    const service = new LifeOpsService(host.runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(host.runtime),
    });
    await service.processScheduledWork({
      now: NOW.toISOString(),
      sleepCycleCheckins: false,
    });
    expect((await store.read()).activeTravel?.value).toEqual(travel);
    expect((await resolveCalendarTimeZone(host.runtime, NOW)).timeZone).toBe(
      "Asia/Tokyo",
    );
  }, 180_000);

  it("expires travel on a cloud host without reopening it from the host zone", async () => {
    await setOwnerTimeZone("America/Los_Angeles");
    const store = resolveOwnerFactStore(host.runtime);
    await store.setActiveTravel(
      {
        startIso: "2026-03-01T00:00:00.000Z",
        endIso: "2026-03-02T00:00:00.000Z",
        destinationTimezone: "Asia/Tokyo",
      },
      { source: "profile_save", recordedAt: NOW.toISOString() },
    );
    const service = new LifeOpsService(host.runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(host.runtime),
    });
    await service.processScheduledWork({
      now: NOW.toISOString(),
      sleepCycleCheckins: false,
    });
    expect((await store.read()).activeTravel).toBeUndefined();
    expect((await actionBill()).bill?.status).toBe("upcoming");
    expect((await routeBill()).bill?.status).toBe("upcoming");
  }, 180_000);

  it("retains timezone travel inference on a recognized personal device", async () => {
    await setOwnerTimeZone("America/Los_Angeles");
    vi.stubEnv("ELIZA_DEVICE_KIND", "mac");
    const service = new LifeOpsService(host.runtime, {
      ownerEntityId: resolveOwnerEntityIdOrDefault(host.runtime),
    });
    await service.processScheduledWork({
      now: NOW.toISOString(),
      sleepCycleCheckins: false,
    });
    expect(
      (await resolveOwnerFactStore(host.runtime).read()).activeTravel?.value
        .destinationTimezone,
    ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect((await actionBill()).bill?.status).toBe("overdue");
    expect((await routeBill()).bill?.status).toBe("overdue");
  }, 180_000);

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
