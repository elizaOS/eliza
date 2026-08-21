/**
 * Unit tests for the e2e cloud-agent cleanup lane's pure decision logic
 * (row normalization, wallet resolution, and deletion selection) plus the
 * CLI help and real-loopback apply paths. Deterministic; no external network
 * or cloud credentials.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertExpectedCleanupIdentity,
  bindReviewedCleanupCandidates,
  normalizeAgentRow,
  resolveE2eWalletPrivateKey,
  selectAgentsForCleanup,
} from "../e2e-agent-cleanup-lib.mjs";

setDefaultTimeout(30_000);

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-08-20T12:00:00Z");
const agent = (id, ageMs, extra = {}) => {
  const createdAtMs = ageMs === null ? null : NOW - ageMs;
  return {
    id,
    agentName: `a-${id}`,
    status: "running",
    executionTier: "dedicated-always",
    createdAt:
      createdAtMs === null ? null : new Date(createdAtMs).toISOString(),
    createdAtMs,
    ...extra,
  };
};

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
      createdAt: "2026-08-20T11:00:00.000Z",
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

  test("defaults to selecting a singleton stale leak", () => {
    expect(
      selectAgentsForCleanup([agent("only", 20 * HOUR)], {
        minAgeMs: 0,
        now: NOW,
      }).toDelete.map((entry) => entry.id),
    ).toEqual(["only"]);
  });

  test("rejects invalid options", () => {
    expect(() => selectAgentsForCleanup([], { keepNewest: -1 })).toThrow();
    expect(() => selectAgentsForCleanup([], { minAgeMs: -5 })).toThrow();
  });
});

describe("destructive binding", () => {
  test("requires reviewed IDs and treats absent IDs as resumable completion", () => {
    const listed = [agent("safe", 20 * HOUR), agent("blocked", 5 * 60 * 1000)];
    const selectable = selectAgentsForCleanup(listed, {
      minAgeMs: HOUR,
      now: NOW,
    }).toDelete;
    expect(
      bindReviewedCleanupCandidates(listed, selectable, ["safe", "absent"]),
    ).toEqual({ toDelete: [listed[0]], alreadyAbsent: ["absent"] });
    expect(() =>
      bindReviewedCleanupCandidates(listed, selectable, ["blocked"]),
    ).toThrow("not safely selectable");
  });

  test("requires independently expected wallet and organization identity", () => {
    const identity = {
      address: "0x1111111111111111111111111111111111111111",
      organizationId: "11111111-1111-4111-8111-111111111111",
    };
    expect(() =>
      assertExpectedCleanupIdentity(identity, {
        expectedAddress: identity.address,
        expectedOrganizationId: identity.organizationId,
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedCleanupIdentity(identity, {
        expectedAddress: "0x2222222222222222222222222222222222222222",
        expectedOrganizationId: identity.organizationId,
      }),
    ).toThrow("identity mismatch");
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

  test("rejects missing flag values and unverifiable non-loopback token mutation before network", async () => {
    const missing = await runCli(["--protect", "--apply"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--protect requires a value");
    const malformedNumber = await runCli(["--keep", "1x"]);
    expect(malformedNumber.exitCode).toBe(1);
    expect(malformedNumber.stderr).toContain("--keep must be");

    const receipt = temporaryReport();
    try {
      const remote = await runCli([
        "--apply",
        "--wait",
        "--candidate",
        "agent-1",
        "--expected-address",
        TEST_ADDRESS,
        "--expected-org",
        TEST_ORG,
        "--report",
        receipt.reportPath,
      ]);
      expect(remote.exitCode).toBe(1);
      expect(remote.stderr).toContain("may not apply cleanup");
    } finally {
      receipt.cleanup();
    }
  });

  test("loopback apply binds conditional identity, waits, verifies absence, and resumes as a no-op", async () => {
    const requests = [];
    const deleteBodies = [];
    let agents = [
      {
        id: "old-dedicated",
        agentName: "Device E2E residue",
        executionTier: "dedicated-always",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "old-shared",
        agentName: "Shared",
        executionTier: "shared",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/v1/credits/balance") {
          return Response.json({ balance: 10 });
        }
        if (url.pathname === "/api/v1/eliza/agents") {
          return Response.json({ data: agents });
        }
        if (url.pathname === "/api/v1/eliza/agents/old-dedicated") {
          deleteBodies.push(await request.json());
          agents = agents.filter((entry) => entry.id !== "old-dedicated");
          return Response.json(
            { data: { jobId: "delete-job" } },
            { status: 202 },
          );
        }
        if (url.pathname === "/api/v1/jobs/delete-job") {
          return Response.json({ data: { status: "completed" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const receipt = temporaryReport();
    try {
      const args = applyArgs(server, receipt.reportPath, ["old-dedicated"]);
      const result = await runCli(args);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("deleted old-dedicated: job/completed");
      expect(requests).toContain("DELETE /api/v1/eliza/agents/old-dedicated");
      expect(deleteBodies).toEqual([
        {
          expectedAgentName: "Device E2E residue",
          expectedCreatedAt: "2026-01-01T00:00:00.000Z",
          expectedExecutionTier: "dedicated-always",
        },
      ]);
      expect(
        JSON.parse(fs.readFileSync(receipt.reportPath, "utf8")),
      ).toMatchObject({
        failure: null,
        verifiedAbsent: ["old-dedicated"],
        attempts: [{ agentId: "old-dedicated", status: "completed" }],
      });

      const second = await runCli(args);
      expect(second.exitCode).toBe(0);
      expect(deleteBodies).toHaveLength(1);
      expect(
        JSON.parse(fs.readFileSync(receipt.reportPath, "utf8")),
      ).toMatchObject({
        alreadyAbsent: ["old-dedicated"],
        attempts: [],
        verifiedAbsent: ["old-dedicated"],
      });
    } finally {
      server.stop(true);
      receipt.cleanup();
    }
  });

  test("treats HTTP failure as authoritative and persists a resumable partial receipt", async () => {
    let agents = [oldAgentRow("first"), oldAgentRow("second")];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/credits/balance") {
          return Response.json({ balance: 10 });
        }
        if (url.pathname === "/api/v1/eliza/agents") {
          return Response.json({ data: agents });
        }
        if (url.pathname.endsWith("/first")) {
          agents = agents.filter((entry) => entry.id !== "first");
          return Response.json({ success: true });
        }
        if (url.pathname.endsWith("/second")) {
          return Response.json(
            { success: true, error: "identity mismatch" },
            { status: 409 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    const receipt = temporaryReport();
    try {
      const result = await runCli(
        applyArgs(server, receipt.reportPath, ["first", "second"]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cloud request failed (409)");
      const report = JSON.parse(fs.readFileSync(receipt.reportPath, "utf8"));
      expect(
        report.attempts.map(({ agentId, status }) => [agentId, status]),
      ).toEqual([
        ["first", "completed"],
        ["second", "failed"],
      ]);
      expect(report.failure).toContain("Cloud request failed (409)");
    } finally {
      server.stop(true);
      receipt.cleanup();
    }
  });

  test("fails when post-delete readback still lists the reviewed candidate", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/credits/balance")
          return Response.json({ balance: 10 });
        if (url.pathname === "/api/v1/eliza/agents") {
          return Response.json({ data: [oldAgentRow("still-listed")] });
        }
        if (url.pathname === "/api/v1/eliza/agents/still-listed") {
          return Response.json({ success: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const receipt = temporaryReport();
    try {
      const result = await runCli(
        applyArgs(server, receipt.reportPath, ["still-listed"]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("post-delete verification still listed");
      expect(
        JSON.parse(fs.readFileSync(receipt.reportPath, "utf8")),
      ).toMatchObject({
        failure: "post-delete verification still listed: still-listed",
        attempts: [{ agentId: "still-listed", status: "completed" }],
        verifiedAbsent: [],
      });
    } finally {
      server.stop(true);
      receipt.cleanup();
    }
  });

  test.each([
    ["failed", "delete job delete-job for old failed"],
    ["running", "delete job delete-job for old timed out"],
  ])(
    "fails closed on a %s delete job and writes the failure receipt",
    async (jobStatus, expectedError) => {
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/credits/balance")
            return Response.json({ balance: 10 });
          if (url.pathname === "/api/v1/eliza/agents") {
            return Response.json({ data: [oldAgentRow("old")] });
          }
          if (url.pathname === "/api/v1/eliza/agents/old") {
            return Response.json(
              { data: { jobId: "delete-job" } },
              { status: 202 },
            );
          }
          if (url.pathname === "/api/v1/jobs/delete-job") {
            return Response.json({ data: { status: jobStatus } });
          }
          return new Response("not found", { status: 404 });
        },
      });
      const receipt = temporaryReport();
      try {
        const result = await runCli([
          ...applyArgs(server, receipt.reportPath, ["old"]),
          "--job-timeout-ms",
          "20",
          "--poll-interval-ms",
          "1",
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(expectedError);
        expect(
          JSON.parse(fs.readFileSync(receipt.reportPath, "utf8")),
        ).toMatchObject({
          attempts: [{ agentId: "old", status: "failed" }],
        });
      } finally {
        server.stop(true);
        receipt.cleanup();
      }
    },
  );

  test("fails before DELETE when the list contains a malformed row", async () => {
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
            data: [{ executionTier: "dedicated-always" }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const receipt = temporaryReport();
    try {
      const result = await runCli(
        applyArgs(server, receipt.reportPath, ["malformed"]),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("without a usable id");
      expect(requests.some((entry) => entry.startsWith("DELETE "))).toBe(false);
    } finally {
      server.stop(true);
      receipt.cleanup();
    }
  });
});

const TEST_ADDRESS = "0x1111111111111111111111111111111111111111";
const TEST_ORG = "11111111-1111-4111-8111-111111111111";

function oldAgentRow(id) {
  return {
    id,
    agentName: `Device E2E ${id}`,
    executionTier: "dedicated-always",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function temporaryReport() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-e2e-cleanup-"),
  );
  return {
    reportPath: path.join(directory, "receipt.json"),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

function applyArgs(server, reportPath, candidateIds) {
  return [
    "--base",
    server.url.toString(),
    "--apply",
    "--wait",
    ...candidateIds.flatMap((id) => ["--candidate", id]),
    "--expected-address",
    TEST_ADDRESS,
    "--expected-org",
    TEST_ORG,
    "--report",
    reportPath,
    "--min-age-minutes",
    "0",
  ];
}

async function runCli(args) {
  const script = path.join(import.meta.dirname, "..", "e2e-agent-cleanup.mjs");
  const process = Bun.spawn(["bun", script, ...args], {
    env: {
      ...Bun.env,
      ELIZA_CLOUD_AUTH_TOKEN: "loopback-test-token",
    },
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
