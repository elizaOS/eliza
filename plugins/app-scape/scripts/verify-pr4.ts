/**
 * PR 4 verify — the autonomous loop pieces.
 *
 * Offline checks (always run):
 *   1. scapeActions array has the expected 5 actions
 *   2. scapeProviders array has the expected 3 providers
 *   3. Plugin.actions / Plugin.providers are populated
 *   4. walkTo action validates against scape_game service availability
 *   5. Param parser extracts x/z/run correctly from a sample LLM response
 *   6. Deferred actions return the "coming in PR 5" fail message
 *   7. Each provider returns empty when there's no perception (graceful)
 *
 * Live check (SCAPE_PR4_LIVE=1, requires xRSPS + BOT_SDK_TOKEN):
 *   8. Construct a throw-away ScapeGameService-style flow:
 *        - Use a real BotManager to connect + spawn
 *        - Wait for perception
 *        - Call each provider against a mock runtime that returns the
 *          live service → verify each produces a JSON string
 *      This exercises the full read path without booting the eliza
 *      runtime.
 */

import appScapePlugin, {
  BotManager,
  type PerceptionSnapshot,
} from "@elizaos/app-scape";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { scapeActions } from "../src/actions/index.js";
import {
  extractParam,
  extractParamBool,
  extractParamInt,
} from "../src/actions/param-parser.js";
import { walkTo } from "../src/actions/walk-to.js";
import { botStateProvider } from "../src/providers/bot-state.js";
import { scapeProviders } from "../src/providers/index.js";
import { inventoryProvider } from "../src/providers/inventory.js";
import { nearbyProvider } from "../src/providers/nearby.js";

/** JSON-based deep-equality for arrays / objects — matches the
 *  plugin's structured-context rule so tests read the same way
 *  the runtime does. */
function deepEqualViaJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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

/**
 * Mock runtime that just returns a mocked "scape_game" service with a
 * preset perception. No elizaOS runtime needed.
 */
function mockRuntime(perception: PerceptionSnapshot | null): IAgentRuntime {
  return {
    getService: (name: string) => {
      if (name !== "scape_game") return null;
      return {
        getPerception: () => perception,
        isConnected: () => perception != null,
        executeAction: async () => ({ success: true, message: "mock" }),
        getStatus: () => "connected",
        getSpawnState: () => null,
      } as unknown as ReturnType<IAgentRuntime["getService"]>;
    },
  } as unknown as IAgentRuntime;
}

function makeDummyMemory(): Memory {
  return {
    content: { text: "action: WALK_TO\nx: 3225\nz: 3220" },
  } as unknown as Memory;
}

function makeSamplePerception(): PerceptionSnapshot {
  return {
    tick: 42,
    self: {
      id: 7,
      name: "scape-verify",
      combatLevel: 3,
      hp: 10,
      maxHp: 10,
      x: 3222,
      z: 3218,
      level: 0,
      runEnergy: 100,
      inCombat: false,
    },
    skills: [
      { id: 0, name: "attack", level: 1, baseLevel: 1, xp: 0 },
      { id: 3, name: "hitpoints", level: 10, baseLevel: 10, xp: 1154 },
    ],
    inventory: [
      { slot: 0, itemId: 1163, name: "item_1163", count: 1 },
      { slot: 1, itemId: 1333, name: "item_1333", count: 1 },
    ],
    equipment: [],
    nearbyNpcs: [],
    nearbyPlayers: [],
    nearbyGroundItems: [],
    nearbyObjects: [],
    recentEvents: [],
  };
}

async function main(): Promise<void> {
  console.log("[verify-pr4] starting");

  // 1. Action registry (final shape, post-PR 6 journal actions)
  console.log("\n[1] action registry");
  assertTrue("scapeActions has 8 entries", scapeActions.length === 8);
  const actionNames = scapeActions.map((a) => a.name);
  assertTrue(
    "actions = WALK_TO, CHAT_PUBLIC, ATTACK_NPC, DROP_ITEM, EAT_FOOD, SET_GOAL, COMPLETE_GOAL, REMEMBER",
    deepEqualViaJson(
      { names: actionNames },
      {
        names: [
          "WALK_TO",
          "CHAT_PUBLIC",
          "ATTACK_NPC",
          "DROP_ITEM",
          "EAT_FOOD",
          "SET_GOAL",
          "COMPLETE_GOAL",
          "REMEMBER",
        ],
      },
    ),
  );

  // 2. Provider registry (final shape, post-PR 6 journal + goals)
  console.log("\n[2] provider registry");
  assertTrue("scapeProviders has 5 entries", scapeProviders.length === 5);
  const providerNames = scapeProviders.map((p) => p.name);
  assertTrue(
    "providers = SCAPE_BOT_STATE, SCAPE_INVENTORY, SCAPE_NEARBY, SCAPE_JOURNAL, SCAPE_GOALS",
    deepEqualViaJson(
      { names: providerNames },
      {
        names: [
          "SCAPE_BOT_STATE",
          "SCAPE_INVENTORY",
          "SCAPE_NEARBY",
          "SCAPE_JOURNAL",
          "SCAPE_GOALS",
        ],
      },
    ),
  );

  // 3. Plugin export has actions + providers
  console.log("\n[3] Plugin.actions / Plugin.providers");
  assertTrue(
    "plugin.actions === scapeActions",
    appScapePlugin.actions === scapeActions,
  );
  assertTrue(
    "plugin.providers === scapeProviders",
    appScapePlugin.providers === scapeProviders,
  );

  // 4. walkTo validates against a runtime that has the service
  console.log("\n[4] walkTo.validate");
  const rtWith = mockRuntime(makeSamplePerception());
  const rtWithout = { getService: () => null } as unknown as IAgentRuntime;
  assertTrue(
    "walkTo.validate(runtime with service) = true",
    (await walkTo.validate?.(rtWith, makeDummyMemory())) === true,
  );
  assertTrue(
    "walkTo.validate(runtime without service) = false",
    (await walkTo.validate?.(rtWithout, makeDummyMemory())) === false,
  );

  // 5. Param parser round-trips
  console.log("\n[5] param parser");
  const llmResponse = "action: WALK_TO\nx: 3225\nz: 3220\nrun: true";
  assertTrue("extractParamInt x", extractParamInt(llmResponse, "x") === 3225);
  assertTrue("extractParamInt z", extractParamInt(llmResponse, "z") === 3220);
  assertTrue(
    "extractParamBool run",
    extractParamBool(llmResponse, "run") === true,
  );
  assertTrue(
    "extractParam action",
    extractParam(llmResponse, "action") === "WALK_TO",
  );
  assertTrue(
    "extractParamInt returns null when missing",
    extractParamInt(llmResponse, "missing") === null,
  );

  // 6. Every action is an Action (name + handler + validate)
  console.log("\n[6] action surface contract");
  for (const action of scapeActions) {
    assertTrue(
      `${action.name} has a handler`,
      typeof action.handler === "function",
    );
    assertTrue(
      `${action.name} has a validate function`,
      typeof action.validate === "function",
    );
  }

  // 7. Providers handle missing perception
  console.log("\n[7] provider graceful degradation");
  const emptyRt = mockRuntime(null);
  const emptyBot = await botStateProvider.get(emptyRt, makeDummyMemory());
  const emptyInv = await inventoryProvider.get(emptyRt, makeDummyMemory());
  const emptyNearby = await nearbyProvider.get(emptyRt, makeDummyMemory());
  assertTrue(
    "bot-state provider returns a non-crash string when no perception",
    typeof emptyBot === "string",
  );
  assertTrue(
    "inventory provider returns empty string when no perception",
    emptyInv === "",
  );
  assertTrue(
    "nearby provider returns empty string when no perception",
    emptyNearby === "",
  );

  // 7b. Providers produce JSON output when perception exists
  console.log("\n[7b] provider output shape");
  const liveRt = mockRuntime(makeSamplePerception());
  const botText = await botStateProvider.get(liveRt, makeDummyMemory());
  const invText = await inventoryProvider.get(liveRt, makeDummyMemory());
  const nearText = await nearbyProvider.get(liveRt, makeDummyMemory());
  assertTrue("bot-state mentions SELF header", botText.includes("# SELF"));
  assertTrue(
    "bot-state mentions position fields",
    botText.includes("name") &&
      botText.includes("hp") &&
      botText.includes("x") &&
      botText.includes("z"),
  );
  assertTrue(
    "inventory mentions INVENTORY header",
    invText.includes("# INVENTORY"),
  );
  assertTrue(
    "inventory has row for each item",
    invText.includes("1163") && invText.includes("1333"),
  );
  assertTrue("nearby mentions NEARBY header", nearText.includes("# NEARBY"));
  assertTrue(
    "nearby lists empty sections (none in range)",
    nearText.includes("(none in range)") && nearText.includes("(none)"),
  );

  // 8. Live test
  if (process.env.SCAPE_PR4_LIVE === "1") {
    console.log("\n[8] live provider test against running xRSPS");
    const token = process.env.BOT_SDK_TOKEN;
    if (!token) {
      console.log("  ⚠  BOT_SDK_TOKEN not set — skipping");
    } else {
      const displayName = `scape-pr4-${Date.now() % 100000}`;
      let gotPerception: PerceptionSnapshot | null = null;
      const mgr = new BotManager(
        {
          url: process.env.BOT_SDK_URL ?? "ws://127.0.0.1:8080/botsdk",
          token,
          agentId: `verify-pr4-${displayName}`,
          displayName,
          password: "verify-pr4-password",
          controller: "hybrid",
        },
        {
          onPerception: (snapshot) => {
            gotPerception = snapshot;
          },
        },
      );
      mgr.connect();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !gotPerception) {
        await delay(200);
      }
      assertTrue("live perception received", gotPerception != null);

      if (gotPerception) {
        const liveRuntime = mockRuntime(gotPerception);
        const liveBot = await botStateProvider.get(
          liveRuntime,
          makeDummyMemory(),
        );
        const liveInv = await inventoryProvider.get(
          liveRuntime,
          makeDummyMemory(),
        );
        const liveNear = await nearbyProvider.get(
          liveRuntime,
          makeDummyMemory(),
        );
        assertTrue("live bot-state has SELF block", liveBot.includes("# SELF"));
        assertTrue(
          "live inventory has INVENTORY block",
          liveInv.includes("# INVENTORY"),
        );
        assertTrue(
          "live nearby has NEARBY block",
          liveNear.includes("# NEARBY"),
        );
      }

      mgr.disconnect("verify_done");
    }
  } else {
    console.log("\n[8] live provider test skipped (set SCAPE_PR4_LIVE=1)");
  }

  if (process.exitCode === 1) {
    console.log("\n[verify-pr4] FAILED");
  } else {
    console.log("\n[verify-pr4] PASSED");
  }
}

main().catch((err) => {
  console.error("[verify-pr4] fatal:", err);
  process.exit(2);
});
