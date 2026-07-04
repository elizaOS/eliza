/**
 * Account-readiness harness (#9960): the loud gate that asserts the pool has
 * ≥1 healthy Codex AND ≥1 healthy Claude (≥2 each for local rotation), instead
 * of the silent single-account fallback in `selectCodingAccount`. Covers the
 * pure assessment and the GET /api/orchestrator/accounts/readiness route, which
 * returns 503 (loud) when the pool is not ready.
 */

// biome-ignore assist/source/organizeImports: comment-only pass preserves import token order.
import { CODING_AGENT_SELECTOR_BRIDGE_SYMBOL } from "@elizaos/core";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleOrchestratorRoutes } from "../../src/api/orchestrator-routes.js";
import type { RouteContext } from "../../src/api/route-utils.js";
import {
  assessCodingAccountReadiness,
  type CodingProviderAvailability,
} from "../../src/services/coding-account-selection.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";

type Availability = Record<string, CodingProviderAvailability[]>;

const av = (
  agentType: string,
  rows: Array<Partial<CodingProviderAvailability>>,
): Availability => ({
  [agentType]: rows.map((r) => ({
    providerId: r.providerId ?? `${agentType}-prov`,
    total: r.total ?? 0,
    enabled: r.enabled ?? 0,
    healthy: r.healthy ?? 0,
  })),
});

describe("assessCodingAccountReadiness", () => {
  it("is ready with >=1 healthy Claude AND >=1 healthy Codex", () => {
    const r = assessCodingAccountReadiness({
      ...av("claude", [{ total: 1, enabled: 1, healthy: 1 }]),
      ...av("codex", [{ total: 1, enabled: 1, healthy: 1 }]),
    });
    expect(r.ready).toBe(true);
    expect(r.required).toBe(1);
    expect(r.problems).toEqual([]);
  });

  it("fails loudly when Codex has zero healthy accounts", () => {
    const r = assessCodingAccountReadiness({
      ...av("claude", [{ total: 1, enabled: 1, healthy: 1 }]),
      ...av("codex", [{ total: 1, enabled: 1, healthy: 0 }]),
    });
    expect(r.ready).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("codex");
    expect(r.problems[0]).toContain(">= 1");
  });

  it("reports a missing provider as none connected", () => {
    const r = assessCodingAccountReadiness(
      av("claude", [{ total: 1, enabled: 1, healthy: 1 }]),
    );
    expect(r.ready).toBe(false);
    expect(r.problems.join(" ")).toContain("codex");
    expect(r.problems.join(" ")).toContain("none connected");
  });

  it("requires >=2 healthy per provider under rotation", () => {
    const oneEach = {
      ...av("claude", [{ total: 1, enabled: 1, healthy: 1 }]),
      ...av("codex", [{ total: 1, enabled: 1, healthy: 1 }]),
    };
    expect(
      assessCodingAccountReadiness(oneEach, { rotation: true }).ready,
    ).toBe(false);
    const twoEach = {
      ...av("claude", [{ total: 2, enabled: 2, healthy: 2 }]),
      ...av("codex", [{ total: 2, enabled: 2, healthy: 2 }]),
    };
    const r = assessCodingAccountReadiness(twoEach, { rotation: true });
    expect(r.ready).toBe(true);
    expect(r.required).toBe(2);
  });

  it("sums healthy across multiple providers for one agent type", () => {
    const r = assessCodingAccountReadiness(
      {
        ...av("claude", [{ total: 1, enabled: 1, healthy: 1 }]),
        codex: [
          { providerId: "openai-codex", total: 1, enabled: 1, healthy: 0 },
          { providerId: "openai-api", total: 1, enabled: 1, healthy: 1 },
        ],
      },
      {},
    );
    expect(r.ready).toBe(true);
    expect(r.providers.find((p) => p.agentType === "codex")?.healthy).toBe(1);
  });
});

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;

function makeService(): OrchestratorTaskService {
  return new OrchestratorTaskService(
    {
      getService: () => null,
      getSetting: () => undefined,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    { store: new OrchestratorTaskStore({ backend: "memory" }) },
  );
}

function ctxWith(service: OrchestratorTaskService): RouteContext {
  return {
    runtime: {
      getService: () => service,
      hasService: () => true,
      getServiceLoadPromise: () => Promise.resolve(undefined),
    },
    acpService: null,
    workspaceService: null,
  } as never;
}

class CapturingResponse {
  statusCode = 0;
  body = "";
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(chunk?: string): this {
    if (chunk !== undefined) this.body = chunk;
    return this;
  }
  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

function withBridge(describe: () => Availability, fn: () => Promise<void>) {
  const g = globalThis as Record<symbol, unknown>;
  const prev = g[BRIDGE_SYMBOL];
  g[BRIDGE_SYMBOL] = { describe };
  return fn().finally(() => {
    if (prev === undefined) delete g[BRIDGE_SYMBOL];
    else g[BRIDGE_SYMBOL] = prev;
  });
}

describe("GET /api/orchestrator/accounts/readiness", () => {
  it("returns 200 when the pool is ready", async () => {
    await withBridge(
      () => ({
        ...av("claude", [{ total: 1, enabled: 1, healthy: 1 }]),
        ...av("codex", [{ total: 1, enabled: 1, healthy: 1 }]),
      }),
      async () => {
        const res = new CapturingResponse();
        const handled = await handleOrchestratorRoutes(
          {
            method: "GET",
            url: "/api/orchestrator/accounts/readiness",
          } as IncomingMessage,
          res as unknown as ServerResponse,
          "/api/orchestrator/accounts/readiness",
          ctxWith(makeService()),
        );
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.json().ready).toBe(true);
      },
    );
  });

  it("fails loudly with 503 + problems when the pool is degraded", async () => {
    await withBridge(
      () => av("claude", [{ total: 1, enabled: 1, healthy: 1 }]), // no codex
      async () => {
        const res = new CapturingResponse();
        await handleOrchestratorRoutes(
          {
            method: "GET",
            url: "/api/orchestrator/accounts/readiness",
          } as IncomingMessage,
          res as unknown as ServerResponse,
          "/api/orchestrator/accounts/readiness",
          ctxWith(makeService()),
        );
        expect(res.statusCode).toBe(503);
        const body = res.json();
        expect(body.ready).toBe(false);
        expect((body.problems as string[]).join(" ")).toContain("codex");
      },
    );
  });

  it("honors ?rotation=1 (requires >=2 healthy each)", async () => {
    await withBridge(
      () => ({
        ...av("claude", [{ total: 1, enabled: 1, healthy: 1 }]),
        ...av("codex", [{ total: 1, enabled: 1, healthy: 1 }]),
      }),
      async () => {
        const res = new CapturingResponse();
        await handleOrchestratorRoutes(
          {
            method: "GET",
            url: "/api/orchestrator/accounts/readiness?rotation=1",
          } as IncomingMessage,
          res as unknown as ServerResponse,
          "/api/orchestrator/accounts/readiness",
          ctxWith(makeService()),
        );
        expect(res.statusCode).toBe(503);
        expect(res.json().required).toBe(2);
        expect(res.json().ready).toBe(false);
      },
    );
  });
});
