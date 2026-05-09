/**
 * PR 3 runtime smoke test for `@elizaos/app-scape`.
 *
 * Exercises the SDK / BotManager / ScapeGameService layer WITHOUT
 * requiring the full eliza runtime to be booted. Flow:
 *
 *   1. Import the SDK types + codec and round-trip an action frame
 *      through JSON encode/decode.
 *   2. Import the BotSdk class and verify its public API shape.
 *   3. Import ScapeGameService and verify it's registered in the
 *      Plugin's `services` array.
 *   4. (optional) If an xRSPS server is already running with
 *      `BOT_SDK_TOKEN=dev-secret`, connect to it end-to-end by
 *      instantiating a BotManager and waiting for a spawnOk + a
 *      perception frame. Controlled by `SCAPE_PR3_LIVE=1`.
 *
 * Run:
 *   bun eliza/plugins/app-scape/scripts/verify-pr3.ts
 *   SCAPE_PR3_LIVE=1 BOT_SDK_TOKEN=dev-secret bun eliza/plugins/app-scape/scripts/verify-pr3.ts
 */

import appScapePlugin, {
  BotManager,
  BotSdk,
  type PerceptionSnapshot,
  ScapeGameService,
} from "@elizaos/app-scape";
import { decodeServerFrame, encodeClientFrame } from "../src/sdk/json.js";

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

async function main(): Promise<void> {
  console.log("[verify-pr3] starting");

  // 1. Plugin exports include the service
  console.log("\n[1] plugin service registration");
  assertTrue(
    "plugin.services has one entry",
    appScapePlugin.services?.length === 1,
  );
  assertTrue(
    "service class is ScapeGameService",
    appScapePlugin.services?.[0] === (ScapeGameService as unknown),
  );
  assertTrue(
    "ScapeGameService.serviceType = 'scape_game'",
    (ScapeGameService as { serviceType: string }).serviceType ===
      "scape_game",
  );

  // 2. BotSdk public API shape
  console.log("\n[2] BotSdk public API");
  const sdk = new BotSdk({
    url: "ws://127.0.0.1:1",
    token: "noop",
    agentId: "verify",
    displayName: "verify",
    password: "verify-pw",
    autoReconnect: false,
  });
  assertTrue(
    "sdk.getStatus() = 'idle' on construct",
    sdk.getStatus() === "idle",
  );
  assertTrue("sdk.isConnected() = false", sdk.isConnected() === false);
  assertTrue("sdk.getPerception() = null", sdk.getPerception() === null);
  assertTrue("sdk.getSpawnState() = null", sdk.getSpawnState() === null);

  // 3. BotManager public API shape
  console.log("\n[3] BotManager public API");
  const mgr = new BotManager({
    url: "ws://127.0.0.1:1",
    token: "noop",
    agentId: "verify",
    displayName: "verify",
    password: "verify-pw",
  });
  assertTrue("mgr.isConnected() = false", mgr.isConnected() === false);
  assertTrue("mgr.getStatus() = 'idle'", mgr.getStatus() === "idle");

  // 4. JSON codec round-trip through the plugin's wrapper
  console.log("\n[4] JSON codec round-trip");
  const clientFrame = {
    kind: "action" as const,
    action: "walkTo" as const,
    x: 3210,
    z: 3425,
    run: false,
    correlationId: "test-1",
  };
  const encoded = encodeClientFrame(clientFrame);
  assertTrue("encoded string is non-empty", encoded.length > 0);
  assertTrue(
    "encoded has `kind: action`",
    encoded.includes("kind") && encoded.includes("action"),
  );

  const serverFrame = {
    kind: "ack" as const,
    correlationId: "test-1",
    success: true,
    message: "ok",
  };
  const encodedServer = encodeClientFrame(
    serverFrame as typeof clientFrame,
  );
  const decoded = decodeServerFrame(encodedServer);
  assertTrue("decode returned ok=true", decoded.ok === true);
  if (decoded.ok) {
    assertTrue("decoded kind = ack", decoded.value.kind === "ack");
  }

  // 5. (optional) live connection test against a running xRSPS server
  if (process.env.SCAPE_PR3_LIVE === "1") {
    console.log("\n[5] live connection test (SCAPE_PR3_LIVE=1)");
    const token = process.env.BOT_SDK_TOKEN;
    if (!token) {
      console.log("  ⚠  BOT_SDK_TOKEN not set — skipping live test");
    } else {
      const liveName = `scape-verify-${Date.now() % 100000}`;
      const livePw = "verify-password-1234";
      let gotSpawn = false;
      let gotPerception = false;
      let liveStatus = "";
      const liveSdk = new BotSdk(
        {
          url: process.env.BOT_SDK_URL ?? "ws://127.0.0.1:8080/botsdk",
          token,
          agentId: `verify-${liveName}`,
          displayName: liveName,
          password: livePw,
          controller: "hybrid",
          autoReconnect: false,
        },
        {
          onStatusChange: (s) => {
            liveStatus = s;
          },
          onSpawn: () => {
            gotSpawn = true;
          },
          onPerception: (_snap: PerceptionSnapshot) => {
            gotPerception = true;
          },
          onLog: (_dir, summary) => {
            console.log(`     [sdk] ${summary}`);
          },
        },
      );
      liveSdk.connect();
      // Wait up to 15 seconds for spawn + perception.
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (!gotSpawn || !gotPerception)) {
        await delay(200);
      }
      assertTrue("live spawnOk received", gotSpawn);
      assertTrue("live perception received", gotPerception);
      assertTrue(
        `live final status = 'connected' (was '${liveStatus}')`,
        liveStatus === "connected",
      );
      liveSdk.disconnect("verify_done");
    }
  } else {
    console.log("\n[5] live test skipped (set SCAPE_PR3_LIVE=1 to enable)");
  }

  if (process.exitCode === 1) {
    console.log("\n[verify-pr3] FAILED");
  } else {
    console.log("\n[verify-pr3] PASSED");
  }
}

main().catch((err) => {
  console.error("[verify-pr3] fatal:", err);
  process.exit(2);
});
