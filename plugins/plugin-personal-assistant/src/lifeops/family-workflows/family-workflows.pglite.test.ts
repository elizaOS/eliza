/**
 * Real-PGlite integration coverage for the production family workflow run
 * lease, monthly schedule, route reachability, restart deduplication,
 * concurrency, and packet expense boundary.
 */

import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE } from "@elizaos/plugin-calendar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { familyCoordinationPack } from "../../default-packs/family-coordination.js";
import { handleFamilyWorkflowRoutes } from "../../routes/family-workflows.js";
import type { LifeOpsRouteContext } from "../../routes/lifeops-routes.js";
import { CalendarCardAccessStore } from "../calendar-card.js";
import type { FamilyPacketClaim } from "../family-coordination/index.js";
import { createProductionScheduledTaskDispatcher } from "../scheduled-task/runtime-wiring.js";
import type { RawSqlQuery } from "../sql.js";
import {
  FAMILY_WORKFLOW_RUNTIME_SERVICE,
  FamilyWorkflowRuntimeService,
} from "./runtime.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function waitForRunningLease(db: PGlite): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const table = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_lifeops'
          AND table_name = 'life_family_workflow_runs'
      ) AS present`,
    );
    if (!table.rows[0]?.present) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    const rows = await db.query<{ state: string }>(
      "SELECT state FROM app_lifeops.life_family_workflow_runs",
    );
    if (rows.rows[0]?.state === "running") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the family workflow run lease.");
}

function baseClaim(): FamilyPacketClaim {
  return {
    claimId: "calendar:event-1",
    stableKey: "calendar:event-1",
    section: "custody_calendar",
    statement: "Pickup is September 3 at 3 PM.",
    visibility: "guest_shareable",
    provenance: [
      {
        source: "calendar",
        sourceId: "event-1",
        observedAt: "2026-09-01T12:00:00.000Z",
        contentSha256: sha("event-1"),
      },
    ],
    dates: ["2026-09-03T15:00:00-04:00"],
    requests: [],
    urgency: null,
    commitments: [],
    accountability: [],
  };
}

describe("FamilyWorkflowRuntimeService with real PGlite", () => {
  let db: PGlite;
  let runtime: IAgentRuntime;
  let services: Map<string, unknown>;

  beforeEach(async () => {
    db = await PGlite.create();
    services = new Map();
    runtime = {
      agentId: "agent-a",
      adapter: {
        db: {
          execute: async (query: RawSqlQuery) =>
            db.query(
              query.queryChunks.map((chunk) => chunk.value ?? "").join(""),
            ),
          transaction: async <T>(
            fn: (tx: {
              execute: (query: RawSqlQuery) => Promise<unknown>;
            }) => Promise<T>,
          ) =>
            db.transaction((transaction) =>
              fn({
                execute: async (query) =>
                  transaction.query(
                    query.queryChunks
                      .map((chunk) => chunk.value ?? "")
                      .join(""),
                  ),
              }),
            ),
        },
      },
      getService: (type: string) => services.get(type) ?? null,
    } as unknown as IAgentRuntime;
  });

  afterEach(async () => db.close());

  function makeService(
    options: {
      now?: Date;
      run?: () => Promise<unknown>;
      claims?: FamilyPacketClaim[];
    } = {},
  ) {
    const school = {
      run: vi.fn(
        options.run ??
          (async () => ({
            state: "unchanged",
            runId: "school-run",
            contentSha256: sha("pdf"),
            mediaUrl: "/api/media/pdf.pdf",
          })),
      ),
      configure: vi.fn(),
      status: vi.fn(),
      applyApprovedPlan: vi.fn(),
    };
    const service = new FamilyWorkflowRuntimeService(runtime, {
      now: () => options.now ?? new Date("2026-09-01T13:00:00.000Z"),
      schoolWorkflow: school as never,
      collectClaims: async () => options.claims ?? [baseClaim()],
    });
    services.set(FAMILY_WORKFLOW_RUNTIME_SERVICE, service);
    services.set(CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE, {});
    return { service, school };
  }

  it("runs manually, persists a packet, and deduplicates after service restart", async () => {
    const cleanup = vi.spyOn(CalendarCardAccessStore.prototype, "cleanup");
    const firstService = makeService();
    const first = await firstService.service.runMonthly("manual");
    expect(first.state).toBe("completed");
    expect(first.packet?.claims[0]?.provenance[0]?.sourceId).toBe("event-1");

    const restarted = makeService();
    const replay = await restarted.service.runMonthly("scheduled");
    expect(replay.state).toBe("deduplicated");
    expect(replay.runId).toBe(first.runId);
    expect(restarted.school.run).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("elects one concurrent owner and reports the second run as already running", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = makeService({
      run: async () => {
        await blocked;
        return {
          state: "unchanged",
          runId: "school",
          contentSha256: sha("pdf"),
          mediaUrl: "/api/media/pdf.pdf",
        };
      },
    });
    const firstPromise = service.runMonthly("manual");
    await waitForRunningLease(db);
    const second = await service.runMonthly("scheduled");
    expect(second.state).toBe("already_running");
    release();
    await expect(firstPromise).resolves.toMatchObject({ state: "completed" });
  });

  it("rejects expense projections before a packet can persist", async () => {
    const expense = {
      ...baseClaim(),
      claimId: "expense",
      section: "expenses",
      dataClass: "expense",
    } as never;
    const { service } = makeService({ claims: [expense] });
    await expect(service.runMonthly("manual")).rejects.toMatchObject({
      code: "FAMILY_PACKET_EXPENSE_FORBIDDEN",
    });
    const rows = await db.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM app_lifeops.life_family_packets",
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it("exposes the manual run through the registered route service", async () => {
    makeService();
    let response: unknown;
    let status = 0;
    const ctx = {
      req: {} as never,
      res: {} as never,
      method: "POST",
      pathname: "/api/lifeops/family-workflows/run-now",
      url: new URL("http://localhost/api/lifeops/family-workflows/run-now"),
      state: { runtime, adminEntityId: "self" },
      json: (_res: unknown, data: unknown, nextStatus = 200) => {
        response = data;
        status = nextStatus;
      },
      error: (_res: unknown, message: string, nextStatus = 400) => {
        response = { error: message };
        status = nextStatus;
      },
      readJsonBody: async () => ({}),
      decodePathComponent: (value: string) => value,
    } as unknown as LifeOpsRouteContext;
    expect(await handleFamilyWorkflowRoutes(ctx)).toBe(true);
    expect(status).toBe(200);
    expect(response).toMatchObject({
      state: "completed",
      periodKey: "2026-09",
    });
  });

  it("applies an owner-reviewed school plan through the canonical gateway route", async () => {
    const { school } = makeService();
    let response: unknown;
    const ctx = {
      req: {} as never,
      res: {} as never,
      method: "POST",
      pathname: "/api/lifeops/family-workflows/school/apply",
      url: new URL(
        "http://localhost/api/lifeops/family-workflows/school/apply",
      ),
      state: { runtime, adminEntityId: "self" },
      json: (_res: unknown, data: unknown) => {
        response = data;
      },
      error: (_res: unknown, message: string) => {
        response = { error: message };
      },
      readJsonBody: async () => ({ runId: "school-run-1" }),
      decodePathComponent: (value: string) => value,
    } as unknown as LifeOpsRouteContext;
    expect(await handleFamilyWorkflowRoutes(ctx)).toBe(true);
    expect(school.applyApprovedPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "school-run-1",
        gateway: services.get(CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE),
      }),
    );
    expect(response).toEqual({ applied: true, runId: "school-run-1" });
  });

  it("accepts a verified-recipient draft contract and queues its exact version for approval", async () => {
    const { service } = makeService();
    const createDraft = vi.spyOn(service, "createDraft").mockResolvedValue({
      packetId: "packet/1",
      internalVersion: 1,
      draftVersion: 2,
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "busy_only",
      includedClaimIds: [],
      body: "Busy",
      bodySha256: sha("Busy"),
      transformations: [],
      createdAt: "2026-09-01T13:00:00.000Z",
    });
    const requestDraftApproval = vi
      .spyOn(service, "requestDraftApproval")
      .mockResolvedValue({ id: "approval-1" } as never);
    let response: unknown;
    let status = 0;
    const route = async (pathname: string, body: unknown) => {
      const ctx = {
        req: {} as never,
        res: {} as never,
        method: "POST",
        pathname,
        url: new URL(`http://localhost${pathname}`),
        state: { runtime, adminEntityId: "self" },
        json: (_res: unknown, data: unknown, nextStatus = 200) => {
          response = data;
          status = nextStatus;
        },
        error: (_res: unknown, message: string, nextStatus = 400) => {
          response = { error: message };
          status = nextStatus;
        },
        readJsonBody: async () => body,
        decodePathComponent: (value: string) => value,
      } as unknown as LifeOpsRouteContext;
      await handleFamilyWorkflowRoutes(ctx);
    };

    await route("/api/lifeops/family-workflows/packets/packet%2F1/drafts", {
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "busy_only",
    });
    expect(status).toBe(201);
    expect(createDraft).toHaveBeenCalledWith("packet/1", {
      recipient: "+15551234567",
      recipientEntityId: "guest-1",
      calendarPrivacyMode: "busy_only",
    });

    await route(
      "/api/lifeops/family-workflows/packets/packet%2F1/drafts/2/approval",
      {},
    );
    expect(status).toBe(201);
    expect(response).toEqual({ id: "approval-1" });
    expect(requestDraftApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        packetId: "packet/1",
        draftVersion: 2,
        requestedBy: "self",
        subjectUserId: "self",
      }),
    );
  });

  it("fails closed at the route boundary when no owner runtime is available", async () => {
    let status = 0;
    const ctx = {
      req: {} as never,
      res: {} as never,
      method: "POST",
      pathname: "/api/lifeops/family-workflows/run-now",
      url: new URL("http://localhost/api/lifeops/family-workflows/run-now"),
      state: { runtime: null, adminEntityId: null },
      json: () => undefined,
      error: (_res: unknown, _message: string, nextStatus = 400) => {
        status = nextStatus;
      },
      readJsonBody: async () => ({}),
      decodePathComponent: (value: string) => value,
    } as unknown as LifeOpsRouteContext;
    expect(await handleFamilyWorkflowRoutes(ctx)).toBe(true);
    expect(status).toBe(503);
  });

  it("ships one structural monthly task on the canonical 09:00 Eastern cron", () => {
    expect(familyCoordinationPack.records).toHaveLength(1);
    expect(familyCoordinationPack.records[0]).toMatchObject({
      kind: "watcher",
      trigger: {
        kind: "cron",
        expression: "0 9 1 * *",
        tz: "America/New_York",
      },
      metadata: { systemOperation: "family.monthlyCoordination" },
      ownerVisible: false,
    });
  });

  it("dispatches the structural monthly operation into the runtime service without a second scheduler", async () => {
    const { service } = makeService();
    const run = vi.spyOn(service, "runMonthly");
    const result = await createProductionScheduledTaskDispatcher({
      runtime,
    }).dispatch({
      taskId: "family-monthly",
      kind: "watcher",
      firedAtIso: "2026-09-01T13:00:00.000Z",
      channelKey: "in_app",
      promptInstructions: "structural operation",
      contextRequest: undefined,
      ownerVisible: false,
      metadata: { systemOperation: "family.monthlyCoordination" },
    });
    expect(run).toHaveBeenCalledWith("scheduled");
    expect(result).toMatchObject({ ok: true });
  });
});
