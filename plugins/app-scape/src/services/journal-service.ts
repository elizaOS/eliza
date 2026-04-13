/**
 * JournalService — the glue between the agent's in-world activity
 * and its long-term memory.
 *
 * The service does three jobs:
 *
 *   1. **Hosts the `JournalStore`**. Lazily creates one per agent
 *      id (matching `SCAPE_AGENT_ID`) the first time the agent
 *      spawns. Other components call into the store through this
 *      service so journal plumbing isn't tangled with bot-manager
 *      plumbing.
 *
 *   2. **Captures automatic memories.** Every perception tick, the
 *      service inspects the snapshot for notable deltas (HP drop,
 *      XP gained, item picked up, died, moved to a new map region)
 *      and records a terse memory. These memories feed the
 *      `SCAPE_JOURNAL` provider on the next LLM step so the agent
 *      has continuity between steps.
 *
 *   3. **Exposes a public API** (`setGoal`, `completeGoal`,
 *      `addMemory`) that the LLM-facing Actions call to manipulate
 *      the journal directly.
 *
 * The service is **not** an elizaOS `Service` subclass — it's
 * constructed inline by `ScapeGameService` because it needs to be
 * injected into the `BotManager` callback plumbing before the
 * plugin runtime finishes booting. It exposes a small public
 * surface the action handlers call via
 * `ScapeGameService.getJournalService()`.
 */

import { JournalStore } from "../journal/journal-store.js";
import type {
  JournalGoal,
  JournalMemory,
  JournalProgressEntry,
  JournalState,
} from "../journal/types.js";
import type { PerceptionSnapshot } from "../sdk/types.js";

export interface JournalServiceOptions {
  agentId: string;
  displayName: string;
  rootDir?: string;
  /**
   * Log sink — pass `ScapeGameService`'s logger so journal
   * events share the plugin prefix.
   */
  log?: (line: string) => void;
}

/** Minimum HP delta that triggers a "damage taken" memory. */
const DAMAGE_MEMORY_THRESHOLD = 2;
/** Minimum XP delta per skill that triggers an "XP gained" memory. */
const XP_MEMORY_THRESHOLD = 50;

export class JournalService {
  private readonly store: JournalStore;
  private readonly log: (line: string) => void;

  private lastPerception: PerceptionSnapshot | null = null;

  constructor(options: JournalServiceOptions) {
    this.store = new JournalStore({
      agentId: options.agentId,
      displayName: options.displayName,
      rootDir: options.rootDir,
    });
    this.log = options.log ?? (() => {});
    const existing = this.store.getState();
    this.log(
      `journal loaded (agent=${existing.agentId} memories=${existing.memories.length} goals=${existing.goals.length})`,
    );
  }

  /** Called by ScapeGameService once the agent actually spawns. */
  onSpawn(): void {
    const state = this.store.beginSession();
    this.store.addMemory({
      kind: "session",
      text: `Session #${state.sessionCount} begins.`,
      weight: 3,
    });
    this.log(
      `journal session #${state.sessionCount} started for agent=${state.agentId}`,
    );
  }

  /**
   * Called on every fresh perception frame. Diffs against the
   * previous snapshot to turn notable deltas into memories.
   */
  onPerception(snapshot: PerceptionSnapshot): void {
    try {
      const previous = this.lastPerception;
      this.lastPerception = snapshot;
      if (!previous) {
        // First perception of the session — record position.
        this.store.addMemory({
          kind: "observation",
          text: `Arrived at (${snapshot.self.x}, ${snapshot.self.z}) with ${snapshot.self.hp}/${snapshot.self.maxHp} HP.`,
          x: snapshot.self.x,
          z: snapshot.self.z,
          weight: 2,
        });
        this.snapshotProgress(snapshot);
        return;
      }

      // HP drop
      const hpDelta = snapshot.self.hp - previous.self.hp;
      if (hpDelta <= -DAMAGE_MEMORY_THRESHOLD) {
        this.store.addMemory({
          kind: "combat",
          text: `Took ${Math.abs(hpDelta)} damage (HP ${snapshot.self.hp}/${snapshot.self.maxHp}).`,
          x: snapshot.self.x,
          z: snapshot.self.z,
          weight: hpDelta <= -5 ? 4 : 3,
        });
      } else if (hpDelta >= DAMAGE_MEMORY_THRESHOLD) {
        this.store.addMemory({
          kind: "healing",
          text: `Healed ${hpDelta} HP (${snapshot.self.hp}/${snapshot.self.maxHp}).`,
          weight: 2,
        });
      }

      // XP gained per skill — sample of deltas
      const skillDeltas = computeSkillDeltas(previous.skills, snapshot.skills);
      for (const delta of skillDeltas) {
        if (delta.xpDelta >= XP_MEMORY_THRESHOLD) {
          this.store.addMemory({
            kind: "xp",
            text: `+${delta.xpDelta} ${delta.name} XP (level ${delta.level}).`,
            weight: delta.xpDelta >= 200 ? 3 : 2,
          });
        }
      }

      // Level up
      for (const delta of skillDeltas) {
        if (delta.levelDelta > 0) {
          this.store.addMemory({
            kind: "level",
            text: `Reached level ${delta.level} ${delta.name}!`,
            weight: 4,
          });
        }
      }
    } catch (err) {
      this.log(
        `journal onPerception failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Public API used by actions + providers ──────────────────

  getState(): JournalState {
    return this.store.getState();
  }

  getFilePath(): string {
    return this.store.getFilePath();
  }

  addMemory(partial: Omit<JournalMemory, "id" | "timestamp">): JournalMemory {
    return this.store.addMemory(partial);
  }

  getMemories(limit?: number): JournalMemory[] {
    return this.store.getMemories(limit);
  }

  setGoal(partial: {
    id?: string;
    title: string;
    notes?: string;
    progress?: number;
    source: "agent" | "operator";
  }): JournalGoal {
    const goal = this.store.setGoal(partial);
    this.store.addMemory({
      kind: "goal",
      text: `${partial.source === "operator" ? "Operator" : "Agent"} goal: ${goal.title}`,
      weight: 4,
    });
    return goal;
  }

  markGoalStatus(
    goalId: string,
    status: JournalGoal["status"],
    notes?: string,
  ): JournalGoal | null {
    const goal = this.store.markGoalStatus(goalId, status, notes);
    if (goal) {
      this.store.addMemory({
        kind: "goal",
        text: `Goal "${goal.title}" → ${status}${notes ? `: ${notes}` : ""}`,
        weight: status === "completed" ? 5 : 3,
      });
    }
    return goal;
  }

  getActiveGoal(): JournalGoal | null {
    return this.store.getActiveGoal();
  }

  getGoals(): JournalGoal[] {
    return this.store.getGoals();
  }

  // ─── Internals ────────────────────────────────────────────────

  private snapshotProgress(snapshot: PerceptionSnapshot): void {
    const now = Date.now();
    const entries: JournalProgressEntry[] = snapshot.skills.map((s) => ({
      skillId: s.id,
      skillName: s.name,
      level: s.baseLevel,
      xp: s.xp,
      capturedAt: now,
    }));
    this.store.recordProgress(entries);
  }
}

interface SkillDelta {
  id: number;
  name: string;
  xpDelta: number;
  levelDelta: number;
  level: number;
}

function computeSkillDeltas(
  previous: PerceptionSnapshot["skills"],
  current: PerceptionSnapshot["skills"],
): SkillDelta[] {
  const prevById = new Map(previous.map((s) => [s.id, s] as const));
  const deltas: SkillDelta[] = [];
  for (const skill of current) {
    const prev = prevById.get(skill.id);
    if (!prev) continue;
    const xpDelta = skill.xp - prev.xp;
    const levelDelta = skill.baseLevel - prev.baseLevel;
    if (xpDelta === 0 && levelDelta === 0) continue;
    deltas.push({
      id: skill.id,
      name: skill.name,
      xpDelta,
      levelDelta,
      level: skill.baseLevel,
    });
  }
  return deltas;
}
