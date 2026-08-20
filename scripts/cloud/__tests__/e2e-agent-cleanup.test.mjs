/**
 * Unit tests for the e2e cloud-agent cleanup lane's pure decision logic
 * (row normalization, wallet resolution, and deletion selection) plus the
 * CLI's help path. Deterministic; no network or cloud credentials.
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

  test("unknown createdAt sorts oldest so it is deleted before dated agents", () => {
    const agents = [agent("undated", null), agent("dated", 20 * HOUR)];
    const { toDelete } = selectAgentsForCleanup(agents, {
      keepNewest: 1,
      minAgeMs: 0,
      now: NOW,
    });
    expect(toDelete.map((a) => a.id)).toEqual(["undated"]);
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
});
