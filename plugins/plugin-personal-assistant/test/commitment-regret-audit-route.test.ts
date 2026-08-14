/**
 * Integration proof for the owner-facing commitment regret audit. HTTP-shaped
 * GET requests travel through the real LifeOps route and service into a real
 * PGlite ledger. The suite locks tenant/status filtering, structural ranking,
 * bounded input, response redaction, and the read-only database contract.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifeOpsCommitmentLedgerRecord,
  LifeOpsRepository,
} from "../src/lifeops/index.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "../src/routes/lifeops-routes.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

interface CapturedResponse {
  statusCode?: number;
  body?: string;
}

function buildGetContext(
  runtime: AgentRuntime,
  search = "",
): { ctx: LifeOpsRouteContext; response: CapturedResponse } {
  const pathname = "/api/lifeops/commitments/regret-audit";
  const response: CapturedResponse = {};
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  req.method = "GET";
  const res = new ServerResponse(req);
  res.statusCode = 0;
  res.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    response.body = typeof chunk === "string" ? chunk : "";
    response.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };
  const ctx: LifeOpsRouteContext = {
    req,
    res,
    method: "GET",
    pathname,
    url: new URL(`http://localhost${pathname}${search}`),
    state: { runtime, adminEntityId: null },
    json(target, data, status = 200) {
      target.statusCode = status;
      target.end(JSON.stringify(data));
    },
    error(target, message, status = 400) {
      target.statusCode = status;
      target.end(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return null;
    },
    decodePathComponent(raw) {
      return decodeURIComponent(raw);
    },
  };
  return { ctx, response };
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

describe("commitment regret audit route (real runtime + PGlite)", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;
  let runtime: AgentRuntime;
  let repository: LifeOpsRepository;

  beforeEach(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    await LifeOpsRepository.bootstrapSchema(runtime);
    repository = new LifeOpsRepository(runtime);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("returns a redacted, ranked, agent-scoped audit without mutating the ledger", async () => {
    const observedAt = new Date().toISOString();
    const foreignAgentId = "00000000-0000-0000-0000-000000014864";
    const orphan = createLifeOpsCommitmentLedgerRecord({
      agentId: runtime.agentId,
      source: "sent_mail",
      sourceKey: "gmail:overdue",
      kind: "commitment",
      summary: "Send the overdue renewal decision",
      counterparty: "Mira",
      dueAt: addDays(observedAt, -1),
      confidence: 0.9,
      metadata: { privateThreadId: "must-not-leak" },
      createdAt: addDays(observedAt, -3),
    });
    const tracked = createLifeOpsCommitmentLedgerRecord({
      agentId: runtime.agentId,
      source: "document",
      sourceKey: "contract:tracked",
      kind: "renewal",
      summary: "Review the later tracked contract",
      counterparty: "Acme",
      dueAt: addDays(observedAt, 30),
      confidence: 0.7,
      status: "tracked",
      scheduledTaskId: "task-contract-review",
      metadata: {},
      createdAt: addDays(observedAt, -2),
    });
    const undated = createLifeOpsCommitmentLedgerRecord({
      agentId: runtime.agentId,
      source: "chat",
      sourceKey: "chat:undated",
      kind: "commitment",
      summary: "Send the promised notes",
      counterparty: null,
      dueAt: null,
      confidence: 0.4,
      metadata: {},
      createdAt: addDays(observedAt, -1),
    });
    const inactive = ["completed", "dismissed", "superseded"].map(
      (status, index) =>
        createLifeOpsCommitmentLedgerRecord({
          agentId: runtime.agentId,
          source: "chat",
          sourceKey: `chat:${status}`,
          kind: "commitment",
          summary: `${status} commitment`,
          counterparty: null,
          dueAt: addDays(observedAt, index + 1),
          confidence: 1,
          status: status as "completed" | "dismissed" | "superseded",
          metadata: {},
          createdAt: observedAt,
        }),
    );
    const foreign = createLifeOpsCommitmentLedgerRecord({
      agentId: foreignAgentId,
      source: "sent_mail",
      sourceKey: "gmail:foreign",
      kind: "filing",
      summary: "Foreign tenant filing",
      counterparty: null,
      dueAt: addDays(observedAt, -10),
      confidence: 1,
      metadata: {},
      createdAt: observedAt,
    });
    for (const record of [orphan, tracked, undated, ...inactive, foreign]) {
      await repository.upsertCommitmentLedgerRecord(record);
    }
    const beforeCurrent = await repository.listCommitmentLedgerRecords(
      runtime.agentId,
    );
    const beforeForeign =
      await repository.listCommitmentLedgerRecords(foreignAgentId);

    const beforeRequest = Date.now();
    const { ctx, response } = buildGetContext(
      runtime,
      `?horizonDays=7&agentId=${foreignAgentId}`,
    );
    expect(await handleLifeOpsRoutes(ctx)).toBe(true);
    const afterRequest = Date.now();

    expect(response.statusCode).toBe(200);
    expect(ctx.res.getHeader("cache-control")).toBe("no-store");
    const audit = JSON.parse(response.body ?? "{}") as {
      generatedAt: string;
      horizonDays: number;
      horizonEndAt: string;
      items: Array<Record<string, unknown> & { id: string; reasons: string[] }>;
    };
    const generatedAtMs = Date.parse(audit.generatedAt);
    expect(generatedAtMs).toBeGreaterThanOrEqual(beforeRequest);
    expect(generatedAtMs).toBeLessThanOrEqual(afterRequest);
    expect(Date.parse(audit.horizonEndAt) - generatedAtMs).toBe(7 * 86_400_000);
    expect(audit.horizonDays).toBe(7);
    expect(audit.items.map((item) => item.id)).toEqual([
      orphan.id,
      undated.id,
      tracked.id,
    ]);
    expect(audit.items[0]?.reasons).toEqual(
      expect.arrayContaining([
        "no scheduled tracker",
        "due inside audit horizon",
        "overdue",
      ]),
    );
    expect(audit.items[1]?.reasons).toContain("no explicit due date");
    expect(audit.items[2]?.reasons).not.toContain("due inside audit horizon");
    expect(audit.items[0]).not.toHaveProperty("agentId");
    expect(audit.items[0]).not.toHaveProperty("sourceKey");
    expect(audit.items[0]).not.toHaveProperty("metadata");
    expect(audit.items.map((item) => item.id)).not.toContain(foreign.id);
    expect(audit.items.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(inactive.map((record) => record.id)),
    );

    expect(
      await repository.listCommitmentLedgerRecords(runtime.agentId),
    ).toEqual(beforeCurrent);
    expect(
      await repository.listCommitmentLedgerRecords(foreignAgentId),
    ).toEqual(beforeForeign);
  });

  it("defaults to seven days and accepts the inclusive horizon bounds", async () => {
    for (const [search, expectedDays] of [
      ["", 7],
      ["?horizonDays=1", 1],
      ["?horizonDays=365", 365],
    ] as const) {
      const { ctx, response } = buildGetContext(runtime, search);
      expect(await handleLifeOpsRoutes(ctx)).toBe(true);
      expect(response.statusCode).toBe(200);
      const audit = JSON.parse(response.body ?? "{}") as {
        generatedAt: string;
        horizonDays: number;
        horizonEndAt: string;
        items: unknown[];
      };
      expect(audit.horizonDays).toBe(expectedDays);
      expect(
        Date.parse(audit.horizonEndAt) - Date.parse(audit.generatedAt),
      ).toBe(expectedDays * 86_400_000);
      expect(audit.items).toEqual([]);
    }
  });

  it.each([
    ["0", "horizonDays must be a positive integer"],
    ["-1", "horizonDays must be a positive integer"],
    ["1.5", "horizonDays must be a positive integer"],
    ["later", "horizonDays must be a positive integer"],
    ["366", "horizonDays must be less than or equal to 365"],
  ])(
    "rejects horizonDays=%s before reading the ledger",
    async (value, error) => {
      const listRecords = vi.spyOn(
        LifeOpsRepository.prototype,
        "listCommitmentLedgerRecords",
      );
      const { ctx, response } = buildGetContext(
        runtime,
        `?horizonDays=${encodeURIComponent(value)}`,
      );

      expect(await handleLifeOpsRoutes(ctx)).toBe(true);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body ?? "{}")).toEqual({ error });
      expect(listRecords).not.toHaveBeenCalled();
    },
  );
});
