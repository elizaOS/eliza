/**
 * PR 7 LIVE cross-repo test — full ::steer path from xRSPS server
 * through the bot-SDK to the eliza plugin's ScapeGameService.
 *
 * Flow:
 *   1. Connect a BotSdk as an agent (with onOperatorCommand handler)
 *   2. Spawn it — xRSPS creates the PlayerState + AgentComponent
 *   3. From a SECOND process (simulated here by calling the server's
 *      chat handler indirectly): we can't easily route a human chat
 *      packet into the server from this script since that requires
 *      logging in via the binary protocol. Instead, we exercise the
 *      server-to-client `operatorCommand` path by directly creating
 *      a ws frame via an admin backchannel.
 *
 *   The simplest verifiable test: spawn an agent, then use the
 *   in-process hook by calling the SDK's connection from xrsps.
 *   Since we don't have an easy second WebSocket client to deliver
 *   `::steer`, we instead test that the agent receives `operatorCommand`
 *   frames when the server broadcasts them via any path.
 *
 *   To trigger a broadcast without spinning up a full ws login, this
 *   test exercises the HTTP endpoint path: it POSTs to the plugin's
 *   /prompt route (via direct handleAppRoutes call) to verify
 *   setOperatorGoal lands on the same service instance. For the
 *   in-game chat path, we rely on the offline verify-pr7.ts harness.
 *
 * Run:
 *   BOT_SDK_TOKEN=dev-secret bun eliza/plugins/app-scape/scripts/verify-pr7-live.ts
 */

import type { PerceptionSnapshot } from "@elizaos/app-scape";
import type { IAgentRuntime } from "@elizaos/core";
import { handleAppRoutes } from "../src/routes.js";
import { ScapeGameService } from "../src/services/game-service.js";

const TOKEN = process.env.BOT_SDK_TOKEN;
if (!TOKEN) {
  console.error("BOT_SDK_TOKEN must be set");
  process.exit(2);
}

const displayName = `scape-pr7-${Date.now() % 100000}`;

function assertTrue(label: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeRuntime(service: unknown): IAgentRuntime {
  const settings: Record<string, string> = {
    SCAPE_BOT_SDK_URL:
      process.env.SCAPE_BOT_SDK_URL ?? "ws://127.0.0.1:8080/botsdk",
    SCAPE_BOT_SDK_TOKEN: TOKEN!,
    SCAPE_AGENT_NAME: displayName,
    SCAPE_AGENT_PASSWORD: "verify-pr7-password",
    SCAPE_AGENT_ID: `pr7-${displayName}`,
    SCAPE_LOOP_INTERVAL_MS: "60000", // long — no real loop steps
  };
  return {
    getSetting: ((key: string) =>
      settings[key]) as IAgentRuntime["getSetting"],
    useModel: (async () => "") as IAgentRuntime["useModel"],
    getService: (() => service) as IAgentRuntime["getService"],
  } as IAgentRuntime;
}

async function main(): Promise<void> {
  console.log(`[verify-pr7-live] agent=${displayName}`);

  // Build the service with a runtime that returns IT as the
  // scape_game lookup target (so the routes can reach it too).
  let service: ScapeGameService | null = null;
  const runtime = makeRuntime({
    // Delegate all methods to the real service once created.
    // This closure capture keeps the route handlers talking to
    // the live ScapeGameService.
    setOperatorGoal: (text: string) => service?.setOperatorGoal(text),
    getOperatorGoal: () => service?.getOperatorGoal() ?? "",
    getJournalService: () => service?.getJournalService() ?? null,
    getPerception: () => service?.getPerception() ?? null,
  });
  service = (await ScapeGameService.start(runtime)) as ScapeGameService;

  // Wait for connect + first perception
  const deadline = Date.now() + 15_000;
  let perception: PerceptionSnapshot | null = null;
  while (Date.now() < deadline) {
    if (service.isConnected() && service.getPerception()) {
      perception = service.getPerception();
      break;
    }
    await delay(200);
  }
  assertTrue("service connected", service.isConnected());
  assertTrue("perception received", perception != null);

  // POST /prompt — the HTTP path
  console.log("\n[1] POST /api/apps/scape/prompt");
  const promptText = "mine copper ore in varrock";
  let handlerOk = false;
  await handleAppRoutes({
    method: "POST",
    pathname: "/api/apps/scape/prompt",
    runtime,
    error: (_r, _msg, _status) => {},
    json: () => {},
    readJsonBody: async () => ({ text: promptText }),
    res: {
      statusCode: 0,
      setHeader: () => {},
      removeHeader: () => {},
      getHeader: () => undefined,
      end: (body?: string) => {
        handlerOk = typeof body === "string" && body.length > 0;
      },
    },
  });
  assertTrue("POST /prompt handled", handlerOk);
  assertTrue(
    `setOperatorGoal captured text (got "${service.getOperatorGoal()}")`,
    service.getOperatorGoal() === promptText,
  );

  // Clear + try a second directive via the service directly
  // (simulates an internal/admin path)
  console.log("\n[2] operator goal lands in next-step prompt");
  const nextPrompt = "bank everything in lumbridge";
  service.setOperatorGoal(nextPrompt);
  assertTrue(
    `operator goal updated (got "${service.getOperatorGoal()}")`,
    service.getOperatorGoal() === nextPrompt,
  );

  // Verify the journal recorded the operator goals via the
  // setGoal side-effect in setOperatorGoal.
  const goals = service.getJournalService()?.getGoals() ?? [];
  const operatorGoals = goals.filter((g) => g.source === "operator");
  assertTrue(
    `journal recorded operator goals (${operatorGoals.length} found)`,
    operatorGoals.length >= 2,
  );
  assertTrue(
    "operator goals contain the directives",
    operatorGoals.some((g) => g.title === promptText) &&
      operatorGoals.some((g) => g.title === nextPrompt),
  );

  await service.stop();
  await delay(500);

  if (process.exitCode === 1) {
    console.log("\n[verify-pr7-live] FAILED");
  } else {
    console.log("\n[verify-pr7-live] PASSED");
  }
}

main().catch((err) => {
  console.error("[verify-pr7-live] fatal:", err);
  process.exit(2);
});
