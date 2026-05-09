/**
 * `PendingPromptsStore` — backing store for `PendingPromptsProvider`.
 *
 * When a `ScheduledTask` whose `completionCheck.kind === "user_replied_within"`
 * (or implicit `user_acknowledged`) fires, the W1-A runner records the open
 * prompt here keyed by `roomId`. When an inbound message arrives the planner
 * uses `list(roomId)` to decide whether to route to `complete` / `acknowledge`
 * on the open task instead of treating it as a fresh request.
 *
 * Retention: open prompts are retained for `expiresAt + reopenWindowHours`
 * (default 24h per `wave1-interfaces.md` §1.5) so late inbound replies still
 * correlate. After the reopen window the entry is purged.
 *
 * Backing storage: runtime cache, keyed per room. Bounded per-room slot count
 * to defend against unbounded growth in a noisy chat.
 *
 * Source of truth for the contract: `wave1-interfaces.md` §4.3 +
 * `GAP_ASSESSMENT.md` §3.11.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  asCacheRuntime,
  type RuntimeCacheLike,
} from "../runtime-cache.js";

export type ExpectedReplyKind = "any" | "yes_no" | "approval" | "free_form";

export interface PendingPrompt {
  taskId: string;
  promptSnippet: string;
  firedAt: string;
  expectedReplyKind: ExpectedReplyKind;
  expiresAt?: string;
}

export interface RecordedPendingPrompt extends PendingPrompt {
  roomId: string;
  /**
   * Soft-purge cut-off. After this instant the entry is no longer returned by
   * `list()` and is dropped on the next read. Set to
   * `expiresAt + reopenWindowHours * 3600s`, or `firedAt + 24h` when no
   * `expiresAt` was provided.
   */
  retainUntilIso: string;
}

export interface PendingPromptRecordInput {
  taskId: string;
  roomId: string;
  promptSnippet: string;
  firedAt: string;
  expectedReplyKind?: ExpectedReplyKind;
  expiresAt?: string;
  /** override the default 24h reopen window */
  reopenWindowHours?: number;
}

export interface PendingPromptsStore {
  /** Record that a task with an open prompt has fired into a room. */
  record(input: PendingPromptRecordInput): Promise<RecordedPendingPrompt>;
  /** List open prompts for a room. Excludes prompts past their retain window. */
  list(
    roomId: string,
    opts?: { lookbackMinutes?: number; now?: Date },
  ): Promise<PendingPrompt[]>;
  /** Resolve a pending prompt (called when the runner records a terminal verb). */
  resolve(roomId: string, taskId: string): Promise<void>;
  /** Remove all entries for a task (used by `LIFEOPS.wipe`). */
  forgetTask(taskId: string): Promise<void>;
  /** Remove every recorded entry (used by `LIFEOPS.wipe`). */
  clearAll(): Promise<void>;
}

const PROMPT_SNIPPET_MAX_LENGTH = 120;
const DEFAULT_REOPEN_WINDOW_HOURS = 24;
const PER_ROOM_MAX_PROMPTS = 16;
const ROOM_INDEX_KEY = "eliza:lifeops:pending-prompts:rooms:v1";

function roomCacheKey(roomId: string): string {
  return `eliza:lifeops:pending-prompts:room:${roomId}:v1`;
}

function clampSnippet(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= PROMPT_SNIPPET_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, PROMPT_SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

function isValidIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return Number.isFinite(Date.parse(value));
}

function computeRetainUntil(
  firedAt: string,
  expiresAt: string | undefined,
  reopenWindowHours: number,
): string {
  const baseMs = expiresAt ? Date.parse(expiresAt) : Date.parse(firedAt);
  if (!Number.isFinite(baseMs)) {
    throw new Error("[pending-prompts] cannot compute retain window");
  }
  const retainMs = baseMs + reopenWindowHours * 3_600_000;
  return new Date(retainMs).toISOString();
}

async function loadRoom(
  cache: RuntimeCacheLike,
  roomId: string,
): Promise<RecordedPendingPrompt[]> {
  const stored = await cache.getCache<RecordedPendingPrompt[]>(
    roomCacheKey(roomId),
  );
  return Array.isArray(stored) ? stored : [];
}

async function saveRoom(
  cache: RuntimeCacheLike,
  roomId: string,
  entries: RecordedPendingPrompt[],
): Promise<void> {
  await cache.setCache<RecordedPendingPrompt[]>(roomCacheKey(roomId), entries);
  await registerRoom(cache, roomId);
}

async function registerRoom(
  cache: RuntimeCacheLike,
  roomId: string,
): Promise<void> {
  const stored = await cache.getCache<string[]>(ROOM_INDEX_KEY);
  const next = new Set<string>(Array.isArray(stored) ? stored : []);
  next.add(roomId);
  await cache.setCache<string[]>(ROOM_INDEX_KEY, [...next]);
}

async function listRooms(cache: RuntimeCacheLike): Promise<string[]> {
  const stored = await cache.getCache<string[]>(ROOM_INDEX_KEY);
  return Array.isArray(stored) ? stored : [];
}

export function createPendingPromptsStore(
  runtime: IAgentRuntime,
): PendingPromptsStore {
  const cache = asCacheRuntime(runtime);

  return {
    async record(
      input: PendingPromptRecordInput,
    ): Promise<RecordedPendingPrompt> {
      if (!input.roomId || typeof input.roomId !== "string") {
        throw new Error("[pending-prompts] roomId is required");
      }
      if (!input.taskId || typeof input.taskId !== "string") {
        throw new Error("[pending-prompts] taskId is required");
      }
      if (!isValidIso(input.firedAt)) {
        throw new Error("[pending-prompts] firedAt must be ISO-8601");
      }
      if (input.expiresAt !== undefined && !isValidIso(input.expiresAt)) {
        throw new Error("[pending-prompts] expiresAt must be ISO-8601");
      }
      const reopenWindowHours =
        typeof input.reopenWindowHours === "number" &&
        input.reopenWindowHours > 0
          ? input.reopenWindowHours
          : DEFAULT_REOPEN_WINDOW_HOURS;
      const recorded: RecordedPendingPrompt = {
        roomId: input.roomId,
        taskId: input.taskId,
        promptSnippet: clampSnippet(input.promptSnippet),
        firedAt: input.firedAt,
        expectedReplyKind: input.expectedReplyKind ?? "any",
        retainUntilIso: computeRetainUntil(
          input.firedAt,
          input.expiresAt,
          reopenWindowHours,
        ),
      };
      if (input.expiresAt !== undefined) {
        recorded.expiresAt = input.expiresAt;
      }
      const existing = await loadRoom(cache, input.roomId);
      const filtered = existing.filter(
        (entry) => entry.taskId !== input.taskId,
      );
      filtered.push(recorded);
      // Bound per-room growth: keep newest N entries (FIFO eviction).
      const trimmed =
        filtered.length > PER_ROOM_MAX_PROMPTS
          ? filtered.slice(-PER_ROOM_MAX_PROMPTS)
          : filtered;
      await saveRoom(cache, input.roomId, trimmed);
      return recorded;
    },

    async list(
      roomId: string,
      opts: { lookbackMinutes?: number; now?: Date } = {},
    ): Promise<PendingPrompt[]> {
      const now = opts.now ?? new Date();
      const lookbackCutoffMs =
        typeof opts.lookbackMinutes === "number" && opts.lookbackMinutes > 0
          ? now.getTime() - opts.lookbackMinutes * 60_000
          : null;

      const stored = await loadRoom(cache, roomId);
      let mutated = false;
      const live: RecordedPendingPrompt[] = [];
      for (const entry of stored) {
        const retainMs = Date.parse(entry.retainUntilIso);
        if (Number.isFinite(retainMs) && retainMs <= now.getTime()) {
          mutated = true;
          continue;
        }
        live.push(entry);
      }
      if (mutated) {
        await saveRoom(cache, roomId, live);
      }

      const visible = live.filter((entry) => {
        if (lookbackCutoffMs === null) return true;
        const firedMs = Date.parse(entry.firedAt);
        return Number.isFinite(firedMs) && firedMs >= lookbackCutoffMs;
      });

      return visible
        .slice()
        .sort((a, b) => Date.parse(b.firedAt) - Date.parse(a.firedAt))
        .map<PendingPrompt>((entry) => {
          const projected: PendingPrompt = {
            taskId: entry.taskId,
            promptSnippet: entry.promptSnippet,
            firedAt: entry.firedAt,
            expectedReplyKind: entry.expectedReplyKind,
          };
          if (entry.expiresAt !== undefined) {
            projected.expiresAt = entry.expiresAt;
          }
          return projected;
        });
    },

    async resolve(roomId: string, taskId: string): Promise<void> {
      const existing = await loadRoom(cache, roomId);
      const next = existing.filter((entry) => entry.taskId !== taskId);
      if (next.length === existing.length) {
        return;
      }
      await saveRoom(cache, roomId, next);
    },

    async forgetTask(taskId: string): Promise<void> {
      const rooms = await listRooms(cache);
      for (const roomId of rooms) {
        const existing = await loadRoom(cache, roomId);
        const next = existing.filter((entry) => entry.taskId !== taskId);
        if (next.length !== existing.length) {
          await saveRoom(cache, roomId, next);
        }
      }
    },

    async clearAll(): Promise<void> {
      const rooms = await listRooms(cache);
      for (const roomId of rooms) {
        if (typeof cache.deleteCache === "function") {
          await cache.deleteCache(roomCacheKey(roomId));
        } else {
          await cache.setCache<RecordedPendingPrompt[]>(
            roomCacheKey(roomId),
            [],
          );
        }
      }
      if (typeof cache.deleteCache === "function") {
        await cache.deleteCache(ROOM_INDEX_KEY);
      } else {
        await cache.setCache<string[]>(ROOM_INDEX_KEY, []);
      }
    },
  };
}
