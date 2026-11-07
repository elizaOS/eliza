/** Real runtime escalation retries after initial delivery falls through dead channels. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { EscalationService } from "../src/services/escalation.ts";

it("keeps the full retry budget and retries from the delivering channel after initial fall-through", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "escalation-rotation-"));
  const configPath = path.join(directory, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  const channels = ["alpha", "beta", "gamma"];
  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          ownerContacts: Object.fromEntries(
            channels.map((channel) => [
              channel,
              { channelId: `${channel}-owner` },
            ]),
          ),
          escalation: { channels, waitMinutes: 60, maxRetries: 3 },
        },
      },
    }),
  );
  const agentId = randomUUID() as UUID;
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Escalation rotation", bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(path.join(directory, "state.sqlite"), agentId),
  );
  const attempts: string[] = [];
  try {
    await runtime.init();
    for (const channel of channels) {
      runtime.registerSendHandler(channel, async (_rt, target, content) => {
        attempts.push(channel);
        // Only the last channel can deliver; the others are dead transports.
        if (channel !== "gamma") throw new Error(`${channel} is unavailable`);
        return {
          id: randomUUID() as UUID,
          entityId: agentId,
          agentId,
          roomId: randomUUID() as UUID,
          content: { ...content, channelId: target.channelId },
          createdAt: Date.now(),
        };
      });
    }

    const started = await EscalationService.startEscalation(
      runtime,
      "fixture failure",
      "needs review",
    );
    expect(attempts).toEqual(["alpha", "beta", "gamma"]);
    expect(started.channelsSent).toEqual(["gamma"]);
    // Falling through dead channels must not consume the retry budget.
    expect(started.currentStep).toBe(0);

    attempts.length = 0;
    await EscalationService.checkEscalation(runtime, started.id);
    // The retry moves on from the delivering channel and falls through the
    // dead ones, so it still reaches the owner instead of wasting the interval.
    expect(attempts).toEqual(["alpha", "beta", "gamma"]);
    expect(started.currentStep).toBe(1);
    expect(started.resolved).toBe(false);

    attempts.length = 0;
    await EscalationService.checkEscalation(runtime, started.id);
    expect(attempts).toEqual(["alpha", "beta", "gamma"]);
    expect(started.currentStep).toBe(2);
    expect(started.channelsSent).toEqual(["gamma", "gamma", "gamma"]);
    expect(
      await runtime.getCache<{ currentStep: number; nextChannelIndex: number }>(
        `agent:escalation:active:${agentId}`,
      ),
    ).toMatchObject({ currentStep: 2, nextChannelIndex: 3 });

    attempts.length = 0;
    await EscalationService.checkEscalation(runtime, started.id);
    // maxRetries counts sends: initial delivery plus two retries.
    expect(attempts).toEqual([]);
    expect(started.resolved).toBe(true);
  } finally {
    await EscalationService.stop(runtime);
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
