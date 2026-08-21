/**
 * Unit tests for the e2e cloud-agent cleanup lane's pure decision logic
 * (row normalization, wallet resolution, and deletion selection) plus the
 * CLI help and real-loopback apply paths. Deterministic; no external network
 * or cloud credentials.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  normalizeAgentRow,
  resolveE2eWalletPrivateKey,
  selectAgentsForCleanup,
} from "../e2e-agent-cleanup-lib.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-08-20T12:00:00Z");
const agent = (id, ageMs, extra = {}) => ({
  id,
  agentName: `a-${id}`,
  status: "running",
  executionTier: "dedicated-always",
  createdAtMs: ageMs === null ? null : NOW - ageMs,
  ...extra,
});

describe("resolveE2eWalletPrivateKey", () => {
  test("assembles the deterministic default wallet", () => {
    const pk = resolveE2eWalletPrivateKey({});
    expect(pk.startsWith("0x")).toBe(true);
    expect(pk).toHaveLength(66);
  });

  test("honors the ELIZA_E2E_WALLET_PK override", () => {
    expect(resolveE2eWalletPrivateKey({ ELIZA_E2E_WALLET_PK: " 0xabc " })).toBe(
      "0xabc",
    );
  });
});

describe("normalizeAgentRow", () => {
  test("normalizes snake_case and nested data rows", () => {
    const row = normalizeAgentRow({
      data: {
        agent_id: "id-1",
        agent_name: "Eliza",
        status: "running",
        execution_tier: "dedicated-always",
        created_at: "2026-08-20T11:00:00Z",
      },
    });
    expect(row).toEqual({
      id: "id-1",
      agentName: "Eliza",
      status: "running",
      executionTier: "dedicated-always",
      createdAtMs: Date.parse("2026-08-20T11:00:00Z"),
    });
  });

  test("rejects rows without an id and tolerates bad dates", () => {
    expect(normalizeAgentRow({ agentName: "no-id" })).toBeNull();
    expect(normalizeAgentRow(null)).toBeNull();
    expect(normalizeAgentRow(["id"])).toBeNull();
    expect(
      normalizeAgentRow({ id: "x", createdAt: "garbage" }).createdAtMs,
    ).toBeNull();
  });
});

describe("selectAgentsForCleanup", () => {
  test("keeps the newest N and deletes older leaked agents", () => {
    const agents = [
      agent("old-1", 20 * HOUR),
      agent("newest", 2 * HOUR),
      agent("old-2", 10 * HOUR),
    ];
    const { toDelete, kept } = selectAgentsForCleanup(agents, {
      keepNewest: 1,
      minAgeMs: HOUR,
      now: NOW,
    });
    expect(toDelete.map((a) => a.id)).toEqual(["old-2", "old-1"]);
    expect(kept).toEqual([{ agent: agents[1], reason: "kept-newest" }]);
  });

  test("never deletes protected or too-young agents", () => {
    const agents = [
      agent("protected", 20 * HOUR),
      agent("in-flight", 5 * 60 * 1000),
      agent("old", 20 * HOUR),
    ];
    const { toDelete, kept } = selectAgentsForCleanup(agents, {
      keepNewest: 0,
      minAgeMs: 30 * 60 * 1000,
      protectIds: ["protected"],
      now: NOW,
    });
    expect(toDelete.map((a) => a.id)).toEqual(["old"]);
    expect(kept.map((k) => [k.agent.id, k.reason])).toEqual([
      ["protected", "protected"],
      ["in-flight", "younger-than-min-age"],
    ]);
  });

  test("keeps non-dedicated and undated agents out of the destructive set", () => {
    const agents = [
      agent("undated", null),
      agent("shared", 20 * HOUR, { executionTier: "shared" }),
      agent("lazy", 20 * HOUR, { executionTier: "dedicated-lazy" }),
      agent("unknown-tier", 20 * HOUR, { executionTier: "unknown" }),
      agent("dedicated", 20 * HOUR),
    ];
    const { toDelete, kept } = selectAgentsForCleanup(agents, {
      keepNewest: 0,
      minAgeMs: 0,
      now: NOW,
    });
    expect(toDelete.map((a) => a.id)).toEqual(["dedicated"]);
    expect(kept.map((entry) => [entry.agent.id, entry.reason])).toEqual([
      ["undated", "unknown-created-at"],
      ["shared", "not-dedicated-always"],
      ["lazy", "not-dedicated-always"],
      ["unknown-tier", "not-dedicated-always"],
    ]);
  });

  test("empty org and keepNewest larger than eligible delete nothing", () => {
    expect(selectAgentsForCleanup([], { now: NOW }).toDelete).toEqual([]);
    const { toDelete } = selectAgentsForCleanup([agent("only", 20 * HOUR)], {
      keepNewest: 3,
      minAgeMs: 0,
      now: NOW,
    });
    expect(toDelete).toEqual([]);
  });

  test("rejects invalid options", () => {
    expect(() => selectAgentsForCleanup([], { keepNewest: -1 })).toThrow();
    expect(() => selectAgentsForCleanup([], { minAgeMs: -5 })).toThrow();
  });
});

describe("cli", () => {
  test("--help exits 0 without touching the network", () => {
    const script = path.join(
      import.meta.dirname,
      "..",
      "e2e-agent-cleanup.mjs",
    );
    const result = spawnSync("bun", [script, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--min-age-minutes");
  });

  test("real loopback apply deletes only an old dedicated agent and waits for its job", async () => {
    const requests = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/v1/credits/balance") {
          return Response.json({ balance: 10 });
        }
        if (url.pathname === "/api/v1/eliza/agents") {
          return Response.json({
            data: [
              {
                id: "old-dedicated",
                executionTier: "dedicated-always",
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                id: "old-shared",
                executionTier: "shared",
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                id: "undated-dedicated",
                executionTier: "dedicated-always",
              },
            ],
          });
        }
        if (url.pathname === "/api/v1/eliza/agents/old-dedicated") {
          return Response.json({ data: { jobId: "delete-job" } }, { status: 202 });
        }
        if (url.pathname === "/api/v1/jobs/delete-job") {
          return Response.json({ data: { status: "completed" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await runCli([
        "--base",
        server.url.toString(),
        "--apply",
        "--wait",
        "--keep",
        "0",
        "--min-age-minutes",
        "0",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("deleted old-dedicated: job/completed");
      expect(requests).toContain("DELETE /api/v1/eliza/agents/old-dedicated");
      expect(requests.some((entry) => entry.includes("old-shared"))).toBe(false);
      expect(requests.some((entry) => entry.includes("undated-dedicated"))).toBe(
        false,
      );
    } finally {
      server.stop(true);
    }
  });

  test("real loopback apply fails closed when the list contains a malformed row", async () => {
    const requests = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/v1/credits/balance") {
          return Response.json({ balance: 10 });
        }
        if (url.pathname === "/api/v1/eliza/agents") {
          return Response.json({ data: [{ executionTier: "dedicated-always" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await runCli([
        "--base",
        server.url.toString(),
        "--apply",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("without a usable id");
      expect(requests.some((entry) => entry.startsWith("DELETE "))).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});

async function runCli(args) {
  const script = path.join(
    import.meta.dirname,
    "..",
    "e2e-agent-cleanup.mjs",
  );
  const process = Bun.spawn(["bun", script, ...args], {
    env: { ...Bun.env, ELIZA_CLOUD_AUTH_TOKEN: "loopback-test-token" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
