/** Real host escalation lifecycle with durable SQLite state across restart. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing";
import { expect, it, vi } from "vitest";
import { EscalationService } from "../src/services/escalation.ts";

it("drains escalation timers without resolving durable state and resumes on a new runtime", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "escalation-shutdown-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(directory, "eliza.json"));
  const runtimes = new Set<AgentRuntime>();
  const agentId = randomUUID() as UUID;
  const openRuntime = async () => {
    const runtime = new AgentRuntime({
      agentId,
      character: { name: "Escalation lifecycle", bio: [], settings: {} },
      logLevel: "fatal",
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(
        path.join(directory, "state.sqlite"),
        agentId,
      ),
    );
    runtimes.add(runtime);
    await runtime.init();
    return runtime;
  };
  try {
    const first = await openRuntime();
    // No connector is registered: this records the unresolved delivery durably.
    const started = await EscalationService.startEscalation(
      first,
      "fixture failure",
      "needs review",
    );
    expect(EscalationService._hasPendingTimerBucket(agentId)).toBe(true);
    await EscalationService.stop(first);
    expect(EscalationService._hasPendingTimerBucket(agentId)).toBe(false);
    expect(EscalationService._hasActiveEscalationBucket(agentId)).toBe(false);
    await expect(
      EscalationService.startEscalation(first, "late", "late"),
    ).rejects.toMatchObject({ code: "ESCALATION_RUNTIME_STOPPED" });
    await first.close();
    runtimes.delete(first);

    const restarted = await openRuntime();
    const persisted = await EscalationService.getActiveEscalation(restarted);
    expect(persisted).toMatchObject({
      id: started.id,
      resolved: false,
      text: "needs review",
    });
    const resumed = await EscalationService.startEscalation(
      restarted,
      "still failing",
      "follow-up",
    );
    expect(resumed.id).toBe(started.id);
    expect(resumed.text).toContain("follow-up");
    expect(EscalationService._hasPendingTimerBucket(agentId)).toBe(true);
    await EscalationService.stop(restarted);
    expect(EscalationService._hasPendingTimerBucket(agentId)).toBe(false);
  } finally {
    for (const runtime of runtimes) {
      await EscalationService.stop(runtime);
      await runtime.close();
    }
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
