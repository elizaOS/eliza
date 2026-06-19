/**
 * Scape Journal type definitions.
 *
 * The journal is the agent's long-term memory. Everything the LLM
 * should remember across sessions lives here: observations,
 * decisions, outcomes, goals, and progress milestones. It is
 * distinct from the xRSPS `player-state.json` save file (which
 * holds mechanical state — skills, inventory, bank) in that the
 * journal captures NARRATIVE state: what the agent learned, what
 * it wanted, what it achieved.
 *
 * The journal is stored on disk as JSON so app tooling and trajectory
 * viewers can inspect it directly.
 *
 * Shape rules:
 *   - Every record has a stable `id` for dedup / update
 *   - Timestamps are Unix millis (Date.now())
 *   - String fields are short — this is context for an LLM, not
 *     a paragraph log
 *   - Arrays are bounded (recent memories are trimmed, abandoned
 *     goals are archived)
 */

/** One thing the agent observed / did / decided. Bounded string. */
export interface JournalMemory {
  /** Stable id — UUID-ish, matches any reference-by-id in the text. */
  id: string;
  /** Unix millis when the memory was captured. */
  timestamp: number;
  /**
   * Short category tag so the LLM can filter at a glance.
   * Examples: "observation", "decision", "outcome", "lesson",
   *           "encounter", "milestone", "operator".
   */
  kind: string;
  /** Short human-readable description, ideally ≤160 chars. */
  text: string;
  /** Optional tile where the memory was captured. */
  x?: number;
  z?: number;
  /** Optional "importance" 1..5 used to pick which to prune first. */
  weight?: number;
}

/** A goal the agent is currently pursuing, has completed, or abandoned. */
export interface JournalGoal {
  id: string;
  /** When the goal was created. */
  createdAt: number;
  /** When the goal was last updated. */
  updatedAt: number;
  /**
   * Status lifecycle — agents propose goals with `active`, move
   * to `completed` on success or `abandoned` on give-up. `paused`
   * is used when an operator command temporarily overrides it.
   */
  status: "active" | "completed" | "abandoned" | "paused";
  /** Short one-line description, e.g. "Reach 20 mining". */
  title: string;
  /**
   * Optional free-form progress notes (bounded). The LLM rewrites
   * these each time it updates the goal.
   */
  notes?: string;
  /** Optional numeric progress 0..1 for UI rendering. */
  progress?: number;
  /** Who proposed this goal — "agent" or "operator". */
  source: "agent" | "operator";
}

/**
 * Per-skill progress snapshot captured on demand, used so the
 * agent can compare "now vs last week" without recomputing.
 */
export interface JournalProgressEntry {
  skillId: number;
  skillName: string;
  level: number;
  xp: number;
  capturedAt: number;
}

/**
 * Top-level journal record, one per agent. Persisted as a single
 * JSON file at `<dataDir>/scape-journals/<agentId>.json`.
 */
export interface JournalState {
  /** Stable agent id — matches `SCAPE_AGENT_ID`. */
  agentId: string;
  /** Agent's display name (may change between sessions). */
  displayName: string;
  /** When the journal was first created. */
  createdAt: number;
  /** When the journal was last written. */
  updatedAt: number;
  /** Bounded ring of recent memories, newest last. */
  memories: JournalMemory[];
  /** All known goals, regardless of status. */
  goals: JournalGoal[];
  /** Progress snapshots keyed by when they were taken. */
  progress: JournalProgressEntry[];
  /**
   * Monotonically increasing session counter. Incremented on
   * every successful spawn so the agent can reference "this
   * session" vs "last session" in its prompts.
   */
  sessionCount: number;
}

/** Maximum memories kept before older ones are dropped. */
export const MAX_MEMORIES = 40;
/** Maximum progress snapshots kept. */
export const MAX_PROGRESS = 20;
/** Maximum archived goals (completed + abandoned) kept. */
export const MAX_ARCHIVED_GOALS = 30;
