/**
 * JournalStore — atomic JSON-file persistence for the Scape Journal.
 *
 * Mirrors the xRSPS `AccountStore` pattern (scrypt hashes) and
 * `PlayerPersistence` pattern (game state) — same atomic rename-on-
 * write, same defensive "load returns fresh on corruption" behavior
 * — and stores the on-disk format as JSON so the app and trajectory tooling
 * can inspect journal state directly.
 *
 * Concurrency: synchronous. One journal per agent, one agent per
 * session. The bot-SDK does not spawn multiple concurrent sessions
 * for the same agent id.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  type JournalGoal,
  type JournalMemory,
  type JournalProgressEntry,
  type JournalState,
  MAX_ARCHIVED_GOALS,
  MAX_MEMORIES,
  MAX_PROGRESS,
} from "./types.js";

export interface JournalStoreOptions {
  /** Agent identifier — used as the filename (sanitized). */
  agentId: string;
  /** Display name stored in the journal for human readability. */
  displayName: string;
  /**
   * Override the journal root. Defaults to
   * `~/.eliza/scape-journals/`. Mostly used by tests.
   */
  rootDir?: string;
}

function defaultRootDir(): string {
  return join(homedir(), ".eliza", "scape-journals");
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 128);
}

function isJournalState(value: unknown): value is JournalState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.agentId === "string" &&
    typeof candidate.displayName === "string" &&
    typeof candidate.createdAt === "number" &&
    Array.isArray(candidate.memories) &&
    Array.isArray(candidate.goals) &&
    Array.isArray(candidate.progress)
  );
}

export class JournalStore {
  private readonly filePath: string;
  private state: JournalState;

  constructor(private readonly options: JournalStoreOptions) {
    const root = options.rootDir ?? defaultRootDir();
    const safeName = sanitizeFilename(options.agentId);
    this.filePath = join(root, `${safeName}.json`);
    this.state = this.loadOrCreate();
  }

  /** Absolute path to the JSON journal file for this agent. */
  getFilePath(): string {
    return this.filePath;
  }

  /** Full journal state — callers should treat as immutable. */
  getState(): JournalState {
    return this.state;
  }

  /** Increment the session counter on successful spawn. */
  beginSession(): JournalState {
    this.state = {
      ...this.state,
      sessionCount: this.state.sessionCount + 1,
      updatedAt: Date.now(),
    };
    this.save();
    return this.state;
  }

  // ─── Memories ─────────────────────────────────────────────────

  addMemory(memory: Omit<JournalMemory, "id" | "timestamp">): JournalMemory {
    const id = newId();
    const full: JournalMemory = {
      id,
      timestamp: Date.now(),
      ...memory,
    };
    const memories = [...this.state.memories, full];
    if (memories.length > MAX_MEMORIES) {
      // Drop the oldest low-weight memory. If everything is
      // weight >= 4 we drop the oldest regardless.
      const pruneIdx = findPruneIndex(memories);
      memories.splice(pruneIdx, 1);
    }
    this.state = {
      ...this.state,
      memories,
      updatedAt: Date.now(),
    };
    this.save();
    return full;
  }

  getMemories(limit?: number): JournalMemory[] {
    if (limit === undefined) return this.state.memories;
    return this.state.memories.slice(-Math.max(0, limit));
  }

  // ─── Goals ────────────────────────────────────────────────────

  setGoal(partial: {
    id?: string;
    title: string;
    notes?: string;
    progress?: number;
    source: "agent" | "operator";
  }): JournalGoal {
    const now = Date.now();
    const existing =
      partial.id != null
        ? this.state.goals.find((g) => g.id === partial.id)
        : undefined;
    if (existing) {
      const updated: JournalGoal = {
        ...existing,
        title: partial.title,
        notes: partial.notes,
        progress: partial.progress,
        source: partial.source,
        status: "active",
        updatedAt: now,
      };
      const goals = this.state.goals.map((g) =>
        g.id === existing.id ? updated : g,
      );
      this.state = { ...this.state, goals, updatedAt: now };
      this.save();
      return updated;
    }
    const created: JournalGoal = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      status: "active",
      title: partial.title,
      notes: partial.notes,
      progress: partial.progress,
      source: partial.source,
    };
    const goals = [...this.state.goals, created];
    this.state = { ...this.state, goals, updatedAt: now };
    this.pruneArchived();
    this.save();
    return created;
  }

  markGoalStatus(
    goalId: string,
    status: JournalGoal["status"],
    notes?: string,
  ): JournalGoal | null {
    const existing = this.state.goals.find((g) => g.id === goalId);
    if (!existing) return null;
    const updated: JournalGoal = {
      ...existing,
      status,
      notes: notes ?? existing.notes,
      updatedAt: Date.now(),
    };
    const goals = this.state.goals.map((g) => (g.id === goalId ? updated : g));
    this.state = { ...this.state, goals, updatedAt: Date.now() };
    this.pruneArchived();
    this.save();
    return updated;
  }

  getGoals(): JournalGoal[] {
    return this.state.goals;
  }

  getActiveGoal(): JournalGoal | null {
    return (
      this.state.goals
        .filter((g) => g.status === "active")
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    );
  }

  // ─── Progress ─────────────────────────────────────────────────

  recordProgress(entries: JournalProgressEntry[]): void {
    if (entries.length === 0) return;
    const progress = [...this.state.progress, ...entries];
    while (progress.length > MAX_PROGRESS) progress.shift();
    this.state = { ...this.state, progress, updatedAt: Date.now() };
    this.save();
  }

  // ─── Persistence ──────────────────────────────────────────────

  private loadOrCreate(): JournalState {
    if (!existsSync(this.filePath)) {
      return this.freshState();
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (isJournalState(parsed)) {
        return parsed;
      }
      console.warn(
        `[scape-journal] ${this.filePath} did not parse as a JournalState — starting fresh`,
      );
    } catch (err) {
      console.warn(`[scape-journal] failed to read ${this.filePath}:`, err);
    }
    return this.freshState();
  }

  private freshState(): JournalState {
    const now = Date.now();
    return {
      agentId: this.options.agentId,
      displayName: this.options.displayName,
      createdAt: now,
      updatedAt: now,
      memories: [],
      goals: [],
      progress: [],
      sessionCount: 0,
    };
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const json = JSON.stringify(this.state);
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, json);
      renameSync(tmp, this.filePath);
    } catch (err) {
      console.error(`[scape-journal] failed to save ${this.filePath}:`, err);
    }
  }

  private pruneArchived(): void {
    const archived = this.state.goals.filter(
      (g) => g.status === "completed" || g.status === "abandoned",
    );
    if (archived.length <= MAX_ARCHIVED_GOALS) return;
    // Keep the most recent MAX_ARCHIVED_GOALS archived plus all active/paused.
    const keepArchivedIds = new Set(
      archived
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_ARCHIVED_GOALS)
        .map((g) => g.id),
    );
    const goals = this.state.goals.filter((g) => {
      if (g.status === "active" || g.status === "paused") return true;
      return keepArchivedIds.has(g.id);
    });
    this.state = { ...this.state, goals };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  // Short, monotonic per session. Not cryptographically unique,
  // but unique enough for a single agent's journal.
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function findPruneIndex(memories: JournalMemory[]): number {
  // Find the oldest memory with the lowest weight. Ties broken
  // by age (lower index = older).
  let bestIdx = 0;
  let bestWeight = memories[0]?.weight ?? 0;
  for (let i = 1; i < memories.length; i++) {
    const w = memories[i]?.weight ?? 0;
    if (w < bestWeight) {
      bestWeight = w;
      bestIdx = i;
    }
  }
  return bestIdx;
}
