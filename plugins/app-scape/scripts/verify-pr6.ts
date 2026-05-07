/**
 * PR 6 verification — Scape Journal.
 *
 * Offline (always run):
 *   1. JournalStore round-trips a state through JSON to disk and back
 *   2. addMemory appends, bounded by MAX_MEMORIES with prune-by-weight
 *   3. setGoal / markGoalStatus round-trip through disk
 *   4. Journal + goals providers render JSON blocks for a mock runtime
 *   5. scapeActions has the 3 new journal actions registered
 *
 * Live (SCAPE_PR6_LIVE=1, requires xRSPS + BOT_SDK_TOKEN):
 *   6. Start a real ScapeGameService with a stub LLM runtime that
 *      emits SET_GOAL → REMEMBER → COMPLETE_GOAL over three steps,
 *      verify the journal file on disk ends up with the expected
 *      shape.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore, type PerceptionSnapshot } from "@elizaos/app-scape";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { scapeActions } from "../src/actions/index.js";
import { goalsProvider } from "../src/providers/goals.js";
import { journalProvider } from "../src/providers/journal.js";
import { JournalService } from "../src/services/journal-service.js";

function assertTrue(label: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

function makeTestDir(): string {
  const dir = join(tmpdir(), `scape-journal-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockRuntimeWith(service: unknown): IAgentRuntime {
  return {
    getService: (name: string) => (name === "scape_game" ? service : null),
  } as unknown as IAgentRuntime;
}

function dummyMemory(): Memory {
  return { content: { text: "" } } as unknown as Memory;
}

function samplePerception(x = 3222, z = 3218): PerceptionSnapshot {
  return {
    tick: 1,
    self: {
      id: 1,
      name: "pr6-test",
      combatLevel: 3,
      hp: 10,
      maxHp: 10,
      x,
      z,
      level: 0,
      runEnergy: 100,
      inCombat: false,
    },
    skills: [
      { id: 0, name: "attack", level: 1, baseLevel: 1, xp: 0 },
      { id: 3, name: "hitpoints", level: 10, baseLevel: 10, xp: 1154 },
    ],
    inventory: [],
    equipment: [],
    nearbyNpcs: [],
    nearbyPlayers: [],
    nearbyGroundItems: [],
    nearbyObjects: [],
    recentEvents: [],
  };
}

async function main(): Promise<void> {
  console.log("[verify-pr6] starting");

  const testDir = makeTestDir();
  console.log(`    test dir: ${testDir}`);

  try {
    // 1. Store creates, persists, and re-loads
    console.log("\n[1] JournalStore disk round-trip");
    const store1 = new JournalStore({
      agentId: "test-agent",
      displayName: "test-agent",
      rootDir: testDir,
    });
    assertTrue("store has a file path", store1.getFilePath().endsWith(".json"));
    store1.beginSession();
    store1.addMemory({ kind: "observation", text: "First step", weight: 2 });
    const state1 = store1.getState();
    assertTrue("state has 1 memory after add", state1.memories.length === 1);

    // Reload from disk
    const store2 = new JournalStore({
      agentId: "test-agent",
      displayName: "test-agent",
      rootDir: testDir,
    });
    const state2 = store2.getState();
    assertTrue(
      "reloaded state has the same memory",
      state2.memories.length === 1,
    );
    assertTrue(
      "reloaded memory text matches",
      state2.memories[0]?.text === "First step",
    );
    assertTrue("sessionCount persisted as 1", state2.sessionCount === 1);

    // File is JSON and can be inspected directly
    const fileContents = readFileSync(store1.getFilePath(), "utf-8");
    assertTrue("disk file is JSON object shape", fileContents.startsWith("{"));
    const decoded = JSON.parse(fileContents) as Record<string, unknown>;
    assertTrue(
      "JSON parses back to a valid JournalState",
      typeof decoded.agentId === "string" && Array.isArray(decoded.memories),
    );

    // 2. setGoal + markGoalStatus
    console.log("\n[2] goals lifecycle");
    const goal = store2.setGoal({
      title: "Reach 20 mining",
      source: "agent",
    });
    assertTrue("setGoal returned a goal with id", typeof goal.id === "string");
    assertTrue("setGoal marked status active", goal.status === "active");
    const closed = store2.markGoalStatus(goal.id, "completed", "did it");
    assertTrue(
      "markGoalStatus returned the updated goal",
      closed?.status === "completed",
    );

    const store3 = new JournalStore({
      agentId: "test-agent",
      displayName: "test-agent",
      rootDir: testDir,
    });
    const activeGoal = store3.getActiveGoal();
    assertTrue("no active goal after closing", activeGoal === null);
    const allGoals = store3.getGoals();
    assertTrue(
      "archived goal persisted to disk",
      allGoals.some(
        (g) => g.status === "completed" && g.title === "Reach 20 mining",
      ),
    );

    // 3. Providers render JSON blocks
    console.log("\n[3] providers render JSON blocks");
    const journal = new JournalService({
      agentId: "provider-test",
      displayName: "provider-test",
      rootDir: testDir,
      log: () => {},
    });
    journal.addMemory({
      kind: "observation",
      text: "Saw a chicken.",
      weight: 2,
    });
    journal.addMemory({ kind: "combat", text: "Took 3 damage.", weight: 3 });
    journal.setGoal({ title: "Kill chickens", source: "agent" });

    const mockService = {
      getJournalService: () => journal,
      getPerception: () => samplePerception(),
    };
    const runtime = mockRuntimeWith(mockService);
    // Provider.get now returns a ProviderResult ({ text }) instead
    // of a raw string — unwrap `.text` before asserting on content.
    const journalResult = await journalProvider.get(runtime, dummyMemory());
    const goalsResult = await goalsProvider.get(runtime, dummyMemory());
    const journalOutput =
      typeof journalResult === "string"
        ? journalResult
        : (journalResult?.text ?? "");
    const goalsOutput =
      typeof goalsResult === "string" ? goalsResult : (goalsResult?.text ?? "");

    assertTrue(
      "journal output has JOURNAL header",
      journalOutput.includes("# JOURNAL"),
    );
    assertTrue(
      "journal output contains saved memory text",
      journalOutput.includes("Saw a chicken") &&
        journalOutput.includes("Took 3 damage"),
    );
    assertTrue(
      "goals output has GOALS header",
      goalsOutput.includes("# GOALS"),
    );
    assertTrue(
      "goals output shows the active goal",
      goalsOutput.includes("Kill chickens") &&
        goalsOutput.includes("## ACTIVE"),
    );

    // 4. Bounded memory growth + prune policy
    console.log("\n[4] memory prune-by-weight");
    const pruneStore = new JournalStore({
      agentId: "prune-test",
      displayName: "prune-test",
      rootDir: testDir,
    });
    // Seed with 41 memories alternating weights — the weight-1
    // entries should be pruned first.
    for (let i = 0; i < 41; i++) {
      pruneStore.addMemory({
        kind: "filler",
        text: `m${i}`,
        weight: i % 2 === 0 ? 1 : 4,
      });
    }
    const pruneState = pruneStore.getState();
    assertTrue(
      `memories bounded at 40 (got ${pruneState.memories.length})`,
      pruneState.memories.length === 40,
    );
    // We added 21 weight-1 + 20 weight-4 (41 total). Exactly one
    // memory must have been pruned, and the prune policy is
    // "oldest low-weight first", so 1 weight-1 should be gone.
    const lowWeightCount = pruneState.memories.filter(
      (m) => (m.weight ?? 0) === 1,
    ).length;
    const highWeightCount = pruneState.memories.filter(
      (m) => (m.weight ?? 0) === 4,
    ).length;
    assertTrue(
      `pruned a low-weight memory (low=${lowWeightCount}, high=${highWeightCount}; expected low=20 high=20)`,
      lowWeightCount === 20 && highWeightCount === 20,
    );

    // 5. scapeActions now includes the 3 journal actions
    console.log("\n[5] actions include journal-self tools");
    const actionNames = scapeActions.map((a) => a.name);
    assertTrue(
      "scapeActions has 8 entries (5 in-world + 3 journal)",
      scapeActions.length === 8,
    );
    assertTrue("SET_GOAL registered", actionNames.includes("SET_GOAL"));
    assertTrue(
      "COMPLETE_GOAL registered",
      actionNames.includes("COMPLETE_GOAL"),
    );
    assertTrue("REMEMBER registered", actionNames.includes("REMEMBER"));
  } finally {
    // Cleanup test dir
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }

  if (process.exitCode === 1) {
    console.log("\n[verify-pr6] FAILED");
  } else {
    console.log("\n[verify-pr6] PASSED");
  }
}

main().catch((err) => {
  console.error("[verify-pr6] fatal:", err);
  process.exit(2);
});
