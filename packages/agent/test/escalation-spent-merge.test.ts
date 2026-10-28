/**
 * A new owner alert coalesces into an active escalation, and the merged text
 * goes out at that escalation's next retry. An escalation that has no retry
 * left (or that the owner already answered) resolves at its next check
 * without sending, so a new alert merged into it would never reach the
 * owner. Real runtime, SQLite cache and send handlers.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { EscalationService } from "../src/services/escalation.ts";

it("delivers a new alert that arrives after the active escalation used its last retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "escalation-spent-"));
  const configPath = path.join(directory, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          ownerContacts: { alpha: { channelId: "alpha-owner" } },
          escalation: { channels: ["alpha"], waitMinutes: 60, maxRetries: 3 },
        },
      },
    }),
  );
  const agentId = randomUUID() as UUID;
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Escalation spent", bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(path.join(directory, "state.sqlite"), agentId),
  );
  const sent: string[] = [];
  try {
    await runtime.init();
    runtime.registerSendHandler("alpha", async (_rt, target, content) => {
      sent.push(String(content.text ?? ""));
      return {
        id: randomUUID() as UUID,
        entityId: agentId,
        agentId,
        roomId: randomUUID() as UUID,
        content: { ...content, channelId: target.channelId },
        createdAt: Date.now(),
      };
    });

    const first = await EscalationService.startEscalation(
      runtime,
      "first failure",
      "backup job failed",
    );
    // Initial send plus two retries: the retry budget is used up.
    await EscalationService.checkEscalation(runtime, first.id);
    await EscalationService.checkEscalation(runtime, first.id);
    expect(first.currentStep).toBe(2);

    sent.length = 0;
    const second = await EscalationService.startEscalation(
      runtime,
      "second failure",
      "disk is full",
    );
    await EscalationService.checkEscalation(runtime, second.id);

    expect(sent.some((text) => text.includes("disk is full"))).toBe(true);
  } finally {
    await EscalationService.stop(runtime);
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
