/**
 * PR 4 end-to-end loop test — boots a standalone `ScapeGameService`
 * against a live xRSPS bot-SDK, with a hand-rolled runtime stub that
 * fakes `useModel` so we can watch the full loop execute ONE step
 * without spinning up the eliza LLM runtime.
 *
 * Success condition:
 *   - Agent spawns in the world
 *   - First perception arrives
 *   - ScapeGameService starts its autonomous loop
 *   - The stub useModel returns a WALK_TO response
 *   - dispatchFromLoop calls executeAction("walkTo")
 *   - The agent visibly moves in the next perception snapshot
 *
 * Usage:
 *   1. Start xrsps with BOT_SDK_TOKEN=dev-secret
 *   2. BOT_SDK_TOKEN=dev-secret bun eliza/plugins/app-scape/scripts/verify-pr4-live-loop.ts
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { PerceptionSnapshot } from "../src/sdk/types.js";
import { ScapeGameService } from "../src/services/game-service.js";

const TOKEN = process.env.BOT_SDK_TOKEN;
if (!TOKEN) {
  console.error("BOT_SDK_TOKEN must be set");
  process.exit(2);
}

const displayName = `scape-loop-${Date.now() % 100000}`;

function assertTrue(label: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stub runtime: returns settings for the service to read, and a
 * `useModel` that emits a walk-to-adjacent-tile response by reading
 * the current perception from a late-bound callback. The callback is
 * bound after the ScapeGameService is constructed, so the stub always
 * has fresh state when the loop prompts it.
 */
function makeRuntime(): {
  runtime: IAgentRuntime;
  useModelCalls: Array<{ size: string; prompt: string }>;
  bindPerceptionSource: (
    getPerception: () => PerceptionSnapshot | null,
  ) => void;
} {
  const settings: Record<string, string> = {
    SCAPE_BOT_SDK_URL:
      process.env.SCAPE_BOT_SDK_URL ?? "ws://127.0.0.1:8080/botsdk",
    SCAPE_BOT_SDK_TOKEN: TOKEN!,
    SCAPE_AGENT_NAME: displayName,
    SCAPE_AGENT_PASSWORD: "verify-pr4-loop-password",
    SCAPE_AGENT_ID: `verify-pr4-${displayName}`,
    SCAPE_LOOP_INTERVAL_MS: "60000", // long — we'll manually step
  };

  const useModelCalls: Array<{ size: string; prompt: string }> = [];
  let perceptionSource: () => PerceptionSnapshot | null = () => null;

  const runtime: Partial<IAgentRuntime> = {
    getSetting: ((key: string) =>
      settings[key]) as IAgentRuntime["getSetting"],
    useModel: (async (size: string, opts: { prompt: string }) => {
      useModelCalls.push({ size, prompt: opts.prompt });
      const current = perceptionSource();
      if (!current) {
        // Fall back to a fixed offset near the default vanilla
        // spawn. Any agent spawning somewhere else will still
        // produce a distinct destination (the test just checks
        // that POSITION CHANGED, not that it matches an exact
        // tile).
        return "action: WALK_TO\nx: 3225\nz: 3222";
      }
      const x = current.self.x + 1;
      const z = current.self.z;
      return `action: WALK_TO\nx: ${x}\nz: ${z}`;
    }) as IAgentRuntime["useModel"],
    getService: (() => null) as IAgentRuntime["getService"],
  };

  return {
    runtime: runtime as IAgentRuntime,
    useModelCalls,
    bindPerceptionSource: (getPerception) => {
      perceptionSource = getPerception;
    },
  };
}

async function main(): Promise<void> {
  console.log(`[verify-pr4-loop] agent=${displayName}`);

  const { runtime, useModelCalls, bindPerceptionSource } = makeRuntime();
  const service = (await ScapeGameService.start(runtime)) as ScapeGameService;
  // Bind the stub's perception reader to the live service — from now
  // on `useModel` sees whatever the BotManager has cached.
  bindPerceptionSource(() => service.getPerception());

  console.log("\n[1] waiting for connect + first perception");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (service.isConnected() && service.getPerception()) break;
    await delay(200);
  }
  assertTrue("service is connected", service.isConnected());
  const first = service.getPerception();
  assertTrue("first perception received", first != null);

  if (!first) {
    console.log("\n[verify-pr4-loop] FAILED (no perception)");
    await service.stop();
    process.exitCode = 1;
    return;
  }
  const startPosition = { x: first.self.x, z: first.self.z };
  console.log(`    spawn at (${startPosition.x}, ${startPosition.z})`);

  // The autonomous loop has already fired once inside `startLoop()`
  // via the immediate step. Wait a moment for it to run end-to-end.
  console.log("\n[2] waiting for first LLM step to complete");
  await delay(3000);

  assertTrue("useModel was called at least once", useModelCalls.length >= 1);
  if (useModelCalls.length > 0) {
    const promptHead = useModelCalls[0]!.prompt
      .slice(0, 150)
      .replace(/\n/g, "\\n");
    console.log(`    prompt head: ${promptHead}...`);
    assertTrue(
      "prompt contains action list",
      useModelCalls[0]!.prompt.includes("WALK_TO"),
    );
    assertTrue(
      "prompt contains agent position",
      useModelCalls[0]!.prompt.includes(String(startPosition.x)),
    );
  }

  // Wait for the walk to take effect in a subsequent perception.
  console.log("\n[3] waiting for post-walk perception");
  const walkDeadline = Date.now() + 10_000;
  let after: PerceptionSnapshot | null = first;
  while (Date.now() < walkDeadline) {
    const latest = service.getPerception();
    if (
      latest &&
      (latest.self.x !== startPosition.x || latest.self.z !== startPosition.z)
    ) {
      after = latest;
      break;
    }
    await delay(300);
  }
  const moved =
    !!after &&
    (after.self.x !== startPosition.x || after.self.z !== startPosition.z);
  assertTrue(
    `agent moved from spawn (start=(${startPosition.x}, ${startPosition.z}) after=(${after?.self.x}, ${after?.self.z}))`,
    moved,
  );

  await service.stop();

  if (process.exitCode === 1) {
    console.log("\n[verify-pr4-loop] FAILED");
  } else {
    console.log("\n[verify-pr4-loop] PASSED");
  }
}

main().catch((err) => {
  console.error("[verify-pr4-loop] fatal:", err);
  process.exit(2);
});
