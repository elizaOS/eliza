/** Exercises the sandbox audit outbox against a real file-backed SQLite runtime: entries wait for a durable sink, survive runtime restart in order, and a failed required sink rejects the record. No storage is mocked. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import {
  createRuntimeLogAuditSink,
  queryAuditFeed,
  SANDBOX_AUDIT_LOG_TYPE,
  SandboxAuditLog,
} from "../src/security/audit-log.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function openRuntime(file: string, agentId: UUID) {
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Audit durability acceptance", bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(file, runtime.agentId),
  );
  await runtime.init();
  return runtime;
}

async function storage() {
  const directory = await mkdtemp(path.join(tmpdir(), "sandbox-audit-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return {
    file: path.join(directory, "agent.sqlite"),
    agentId: randomUUID() as UUID,
  };
}

it("holds entries until a durable sink commits them and keeps them across restart", async () => {
  const { file, agentId } = await storage();
  const runtime = await openRuntime(file, agentId);
  let open = true;
  cleanups.push(async () => {
    if (open) await runtime.close();
  });
  const audit = new SandboxAuditLog({
    console: false,
    requireDurableSink: true,
  });

  let settled = false;
  const held = audit
    .record({
      type: "sandbox_lifecycle",
      summary: "Sandbox initialized: mode=standard",
      severity: "info",
    })
    .then(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(audit.pendingCount).toBe(1);
  expect(await runtime.getLogs({ type: SANDBOX_AUDIT_LOG_TYPE })).toEqual([]);

  await audit.addSink(await createRuntimeLogAuditSink(runtime));
  await held;
  expect(audit.pendingCount).toBe(0);
  await audit.recordPolicyDecision("deny", "egress host is not granted", {
    host: "blocked.example.invalid",
  });

  await runtime.close();
  open = false;
  const restarted = await openRuntime(file, agentId);
  cleanups.push(() => restarted.close());
  const rows = await restarted.getLogs({ type: SANDBOX_AUDIT_LOG_TYPE });
  const committed = rows
    .map((row) => row.body.metadata as Record<string, unknown>)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  expect(committed).toMatchObject([
    {
      type: "sandbox_lifecycle",
      summary: "Sandbox initialized: mode=standard",
      severity: "info",
    },
    {
      type: "policy_decision",
      summary: "deny: egress host is not granted",
      severity: "warn",
      fields: {
        decision: "deny",
        reason: "egress host is not granted",
        host: "blocked.example.invalid",
      },
    },
  ]);
});

it("rejects sink attachment and every queued record when storage is unavailable", async () => {
  const { file, agentId } = await storage();
  const runtime = await openRuntime(file, agentId);
  const sink = await createRuntimeLogAuditSink(runtime);
  await runtime.close();
  const audit = new SandboxAuditLog({
    console: false,
    requireDurableSink: true,
  });
  const records = Promise.allSettled([
    audit.record({
      type: "sandbox_lifecycle",
      summary: "first",
      severity: "info",
    }),
    audit.record({
      type: "sandbox_lifecycle",
      summary: "second",
      severity: "info",
    }),
  ]);

  await expect(audit.addSink(sink)).rejects.toMatchObject({
    code: "AUDIT_SINK_FAILED",
    context: { failedEntries: 2 },
  });
  expect(await records).toMatchObject([
    { status: "rejected", reason: { code: "AUDIT_SINK_FAILED" } },
    { status: "rejected", reason: { code: "AUDIT_SINK_FAILED" } },
  ]);
  expect(audit.pendingCount).toBe(0);

  const reopened = await openRuntime(file, agentId);
  cleanups.push(() => reopened.close());
  expect(await reopened.getLogs({ type: SANDBOX_AUDIT_LOG_TYPE })).toEqual([]);
});

it.each([true, false])(
  "rejects a record when durable storage cannot commit it (sink required: %s)",
  async (required) => {
    const { file, agentId } = await storage();
    const runtime = await openRuntime(file, agentId);
    const audit = new SandboxAuditLog({
      console: false,
      requireDurableSink: true,
      sinks: [{ ...(await createRuntimeLogAuditSink(runtime)), required }],
    });
    await audit.record({
      type: "sandbox_lifecycle",
      summary: "committed before storage closed",
      severity: "info",
    });
    await runtime.close();

    await expect(
      audit.record({
        type: "security_kill_switch",
        summary: "storage unavailable during kill switch",
        severity: "critical",
      }),
    ).rejects.toMatchObject({ code: "AUDIT_SINK_FAILED" });
    // The bounded operational feed still shows the attempt.
    expect(
      queryAuditFeed({ type: "security_kill_switch" }).map(
        (entry) => entry.summary,
      ),
    ).toContain("storage unavailable during kill switch");

    const reopened = await openRuntime(file, agentId);
    cleanups.push(() => reopened.close());
    const summaries = (
      await reopened.getLogs({ type: SANDBOX_AUDIT_LOG_TYPE })
    ).map((row) => (row.body.metadata as Record<string, unknown>).summary);
    expect(summaries).toEqual(["committed before storage closed"]);
  },
);

it("accepts a durable fallback after an optional storage sink fails", async () => {
  const failedStorage = await storage();
  const failedRuntime = await openRuntime(
    failedStorage.file,
    failedStorage.agentId,
  );
  const failedSink = await createRuntimeLogAuditSink(failedRuntime);
  await failedRuntime.close();
  const healthyStorage = await storage();
  const healthyRuntime = await openRuntime(
    healthyStorage.file,
    healthyStorage.agentId,
  );
  cleanups.push(() => healthyRuntime.close());
  const healthySink = await createRuntimeLogAuditSink(healthyRuntime);
  const audit = new SandboxAuditLog({
    console: false,
    requireDurableSink: true,
    sinks: [
      { ...failedSink, name: "unavailable-storage", required: false },
      { ...healthySink, name: "healthy-storage", required: false },
    ],
  });
  await audit.record({
    type: "sandbox_lifecycle",
    summary: "committed by fallback",
    severity: "info",
  });
  expect(
    await healthyRuntime.getLogs({ type: SANDBOX_AUDIT_LOG_TYPE }),
  ).toMatchObject([
    { body: { metadata: { summary: "committed by fallback" } } },
  ]);
});
