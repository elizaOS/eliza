/**
 * PR 5 live verification — exercises every action in the toolbelt
 * by sending raw JSON frames over the bot-SDK and asserting the
 * expected side effects.
 *
 * Actions covered:
 *   1. walkTo       — agent moves to a new tile
 *   2. chatPublic   — server accepts a public chat broadcast (ack=ok)
 *   3. attackNpc    — negative path: attacking id=0 yields "no NPC"
 *   4. dropItem     — negative path: dropping empty slot yields error
 *   5. eatFood      — negative path: eating empty slot yields error
 *
 * The negative-path assertions for attackNpc/dropItem/eatFood are
 * fine for PR 5's gate: they prove the protocol round-trip works
 * and the action router reaches the right branch. Happy-path tests
 * need pre-populated inventories + nearby NPCs, which is out of
 * scope here.
 *
 * Run:
 *   BOT_SDK_TOKEN=dev-secret bun eliza/plugins/app-scape/scripts/verify-pr5.ts
 */

import type { PerceptionSnapshot } from "@elizaos/app-scape";
import { BotSdk } from "@elizaos/app-scape";

const TOKEN = process.env.BOT_SDK_TOKEN;
if (!TOKEN) {
  console.error("BOT_SDK_TOKEN must be set");
  process.exit(2);
}

const displayName = `scape-pr5-${Date.now() % 100000}`;

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

async function main(): Promise<void> {
  console.log(`[verify-pr5] agent=${displayName}`);

  const sdk = new BotSdk(
    {
      url: process.env.BOT_SDK_URL ?? "ws://127.0.0.1:8080/botsdk",
      token: TOKEN!,
      agentId: `pr5-${displayName}`,
      displayName,
      password: "verify-pr5-password",
      controller: "hybrid",
      autoReconnect: false,
    },
    {
      onLog: (_dir, _summary) => {
        // quiet — we print our own assertions below
      },
    },
  );

  sdk.connect();
  console.log("\n[1] waiting for spawn + first perception");
  const deadline = Date.now() + 15_000;
  let perception: PerceptionSnapshot | null = null;
  while (Date.now() < deadline) {
    perception = sdk.getPerception();
    if (sdk.isConnected() && perception) break;
    await delay(200);
  }
  assertTrue("connected", sdk.isConnected());
  assertTrue("perception received", perception != null);
  if (!perception) {
    sdk.disconnect("no_perception");
    console.log("\n[verify-pr5] FAILED");
    return;
  }
  const spawnPos = { x: perception.self.x, z: perception.self.z };
  console.log(`    spawn at (${spawnPos.x}, ${spawnPos.z})`);

  // ─── Action 1: walkTo ─────────────────────────────────────────
  console.log("\n[2] walkTo — happy path");
  const walkResult = await sdk.sendAction({
    action: "walkTo",
    x: spawnPos.x + 2,
    z: spawnPos.z,
  });
  assertTrue(
    `walkTo success=true (message="${walkResult.message}")`,
    walkResult.success === true,
  );
  // Wait for movement to show up in a perception frame.
  const walkDeadline = Date.now() + 10_000;
  let afterWalk = perception;
  while (Date.now() < walkDeadline) {
    const latest = sdk.getPerception();
    if (
      latest &&
      (latest.self.x !== spawnPos.x || latest.self.z !== spawnPos.z)
    ) {
      afterWalk = latest;
      break;
    }
    await delay(300);
  }
  assertTrue(
    `agent moved (end=(${afterWalk.self.x}, ${afterWalk.self.z}))`,
    afterWalk.self.x !== spawnPos.x || afterWalk.self.z !== spawnPos.z,
  );

  // ─── Action 2: chatPublic ─────────────────────────────────────
  console.log("\n[3] chatPublic — happy path");
  const chatResult = await sdk.sendAction({
    action: "chatPublic",
    text: "Hello world from PR 5!",
  });
  assertTrue(
    `chatPublic success=true (message="${chatResult.message}")`,
    chatResult.success === true,
  );
  assertTrue(
    "chatPublic message confirms broadcast",
    typeof chatResult.message === "string" &&
      chatResult.message.toLowerCase().includes("hello world"),
  );

  // Negative: empty text
  console.log("\n[3b] chatPublic — rejects empty text");
  const chatEmpty = await sdk.sendAction({
    action: "chatPublic",
    text: "",
  });
  assertTrue("chatPublic empty text fails", chatEmpty.success === false);

  // ─── Action 3: attackNpc ─────────────────────────────────────
  console.log("\n[4] attackNpc — rejects unknown NPC id");
  const attackBad = await sdk.sendAction({
    action: "attackNpc",
    npcId: 999999, // guaranteed not to exist
  });
  assertTrue("attackNpc unknown id fails", attackBad.success === false);
  assertTrue(
    `attackNpc error mentions NPC id (message="${attackBad.message}")`,
    typeof attackBad.message === "string" &&
      /npc/i.test(attackBad.message ?? ""),
  );

  // ─── Action 4: dropItem ──────────────────────────────────────
  console.log("\n[5] dropItem — rejects empty slot");
  // New agents spawn with an empty inventory, so slot 0 is empty.
  const dropEmpty = await sdk.sendAction({
    action: "dropItem",
    slot: 0,
  });
  assertTrue("dropItem empty slot fails", dropEmpty.success === false);
  assertTrue(
    `dropItem error mentions slot (message="${dropEmpty.message}")`,
    typeof dropEmpty.message === "string" &&
      /slot/i.test(dropEmpty.message ?? ""),
  );

  // Negative: out-of-range slot
  console.log("\n[5b] dropItem — rejects out-of-range slot");
  const dropOutOfRange = await sdk.sendAction({
    action: "dropItem",
    slot: 99,
  });
  assertTrue("dropItem slot=99 fails", dropOutOfRange.success === false);

  // ─── Action 5: eatFood ────────────────────────────────────────
  console.log("\n[6] eatFood — rejects empty inventory");
  const eatEmpty = await sdk.sendAction({
    action: "eatFood",
  });
  assertTrue("eatFood empty inventory fails", eatEmpty.success === false);
  assertTrue(
    `eatFood message explains the failure (message="${eatEmpty.message}")`,
    typeof eatEmpty.message === "string" && eatEmpty.message.length > 0,
  );

  sdk.disconnect("verify_done");
  await delay(500);

  if (process.exitCode === 1) {
    console.log("\n[verify-pr5] FAILED");
  } else {
    console.log("\n[verify-pr5] PASSED");
  }
}

main().catch((err) => {
  console.error("[verify-pr5] fatal:", err);
  process.exit(2);
});
