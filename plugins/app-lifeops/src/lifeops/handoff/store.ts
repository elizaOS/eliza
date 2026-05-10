/**
 * `HandoffStore` — per-room handoff state.
 *
 * When the agent says "I'll let you take it from here" in a multi-party
 * thread, the store flips the room into handoff mode; the
 * `RoomPolicyProvider` reads `status(roomId).active` and gates further
 * agent contributions until the resume condition fires.
 *
 * Backing storage: runtime cache, keyed per-room. Multiple rooms can be in
 * handoff mode simultaneously (unlike `GlobalPauseStore`, which is global).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { asCacheRuntime } from "../runtime-cache.js";

export type ResumeCondition =
  | { kind: "mention" }
  | { kind: "explicit_resume" }
  | { kind: "silence_minutes"; minutes: number }
  | { kind: "user_request_help"; userId: string };

export interface HandoffEnterOpts {
  reason: string;
  resumeOn: ResumeCondition;
}

export interface HandoffStatus {
  active: boolean;
  enteredAt?: string;
  reason?: string;
  resumeOn?: ResumeCondition;
}

export interface HandoffStore {
  enter(roomId: string, opts: HandoffEnterOpts): Promise<void>;
  exit(roomId: string): Promise<void>;
  status(roomId: string, now?: Date): Promise<HandoffStatus>;
}

const HANDOFF_CACHE_KEY_PREFIX = "eliza:lifeops:handoff:v1:";

interface HandoffRecord {
  roomId: string;
  enteredAt: string;
  reason: string;
  resumeOn: ResumeCondition;
}

function cacheKeyForRoom(roomId: string): string {
  return `${HANDOFF_CACHE_KEY_PREFIX}${roomId}`;
}

function isResumeCondition(value: unknown): value is ResumeCondition {
  if (!value || typeof value !== "object") return false;
  const cand = value as { kind?: unknown };
  if (cand.kind === "mention") return true;
  if (cand.kind === "explicit_resume") return true;
  if (cand.kind === "silence_minutes") {
    const minutes = (value as { minutes?: unknown }).minutes;
    return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0;
  }
  if (cand.kind === "user_request_help") {
    const userId = (value as { userId?: unknown }).userId;
    return typeof userId === "string" && userId.length > 0;
  }
  return false;
}

function isValidRecord(value: unknown): value is HandoffRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<HandoffRecord>;
  if (typeof r.roomId !== "string" || r.roomId.length === 0) return false;
  if (typeof r.enteredAt !== "string" || !Number.isFinite(Date.parse(r.enteredAt))) {
    return false;
  }
  if (typeof r.reason !== "string") return false;
  return isResumeCondition(r.resumeOn);
}

function normalizeReason(reason: string): string {
  return reason.trim().slice(0, 200);
}

export function createHandoffStore(runtime: IAgentRuntime): HandoffStore {
  const cache = asCacheRuntime(runtime);

  return {
    async enter(roomId: string, opts: HandoffEnterOpts): Promise<void> {
      if (typeof roomId !== "string" || roomId.length === 0) {
        throw new Error("[handoff] roomId is required");
      }
      if (!isResumeCondition(opts.resumeOn)) {
        throw new Error(
          `[handoff] invalid resumeOn: ${JSON.stringify(opts.resumeOn)}`,
        );
      }
      const reason = normalizeReason(opts.reason ?? "");
      if (reason.length === 0) {
        throw new Error("[handoff] reason is required");
      }
      const record: HandoffRecord = {
        roomId,
        enteredAt: new Date().toISOString(),
        reason,
        resumeOn: opts.resumeOn,
      };
      await cache.setCache<HandoffRecord>(cacheKeyForRoom(roomId), record);
    },

    async exit(roomId: string): Promise<void> {
      if (typeof roomId !== "string" || roomId.length === 0) return;
      await cache.deleteCache(cacheKeyForRoom(roomId));
    },

    async status(roomId: string, _now: Date = new Date()): Promise<HandoffStatus> {
      void _now;
      if (typeof roomId !== "string" || roomId.length === 0) {
        return { active: false };
      }
      const stored = await cache.getCache<HandoffRecord | null>(
        cacheKeyForRoom(roomId),
      );
      if (!isValidRecord(stored)) {
        return { active: false };
      }
      return {
        active: true,
        enteredAt: stored.enteredAt,
        reason: stored.reason,
        resumeOn: stored.resumeOn,
      };
    },
  };
}

/**
 * Decide whether an inbound message satisfies the active resume condition,
 * given a `HandoffStatus`. Used by the `MESSAGE.handoff` resume-detection
 * branch and by the `RoomPolicyProvider` to know whether to inject the
 * "stay-quiet" instruction.
 *
 * Inputs are kept minimal — callers only need to assert the room is in
 * handoff (`status.active`) and pass message-shape facts:
 *   - `mentionsAgent`: true if the inbound message @-mentions the agent.
 *   - `nowIso`: time of the inbound message (defaults to now).
 *   - `lastMessageIso`: last inbound message in the room (for
 *     `silence_minutes`).
 *   - `requestingUserId`: the user-id sending the inbound (for
 *     `user_request_help`).
 *   - `userRequestedHelp`: true if the inbound is a help request from
 *     `requestingUserId` (planner / classifier signal).
 */
export interface ResumeEvaluationInput {
  status: HandoffStatus;
  nowIso?: string;
  mentionsAgent?: boolean;
  lastMessageIso?: string;
  requestingUserId?: string;
  userRequestedHelp?: boolean;
}

export interface ResumeEvaluation {
  shouldResume: boolean;
  reason?: string;
}

export function evaluateResume(input: ResumeEvaluationInput): ResumeEvaluation {
  if (!input.status.active || !input.status.resumeOn) {
    return { shouldResume: false };
  }
  const cond = input.status.resumeOn;
  switch (cond.kind) {
    case "mention":
      return input.mentionsAgent === true
        ? { shouldResume: true, reason: "mentioned" }
        : { shouldResume: false };
    case "explicit_resume":
      // Explicit-resume must be triggered out-of-band via `MESSAGE.handoff`
      // verb=resume; the planner does not auto-resume on any inbound.
      return { shouldResume: false };
    case "silence_minutes": {
      const lastIso = input.lastMessageIso;
      if (!lastIso) return { shouldResume: false };
      const lastMs = Date.parse(lastIso);
      if (!Number.isFinite(lastMs)) return { shouldResume: false };
      const nowMs = input.nowIso ? Date.parse(input.nowIso) : Date.now();
      if (!Number.isFinite(nowMs)) return { shouldResume: false };
      const elapsedMin = (nowMs - lastMs) / 60_000;
      return elapsedMin >= cond.minutes
        ? { shouldResume: true, reason: `silence ≥ ${cond.minutes}m` }
        : { shouldResume: false };
    }
    case "user_request_help":
      return input.userRequestedHelp === true &&
        input.requestingUserId === cond.userId
        ? { shouldResume: true, reason: "user requested help" }
        : { shouldResume: false };
  }
}

/**
 * Render the `ResumeCondition` to a short human-readable phrase used by
 * the `RoomPolicyProvider` when injecting "do not respond unless …" into
 * the planner context.
 */
export function describeResumeCondition(cond: ResumeCondition): string {
  switch (cond.kind) {
    case "mention":
      return "you are @-mentioned";
    case "explicit_resume":
      return "the user explicitly says to resume (LIFEOPS or MESSAGE.handoff verb=resume)";
    case "silence_minutes":
      return `the room has been silent for at least ${cond.minutes} minute${cond.minutes === 1 ? "" : "s"}`;
    case "user_request_help":
      return `the participant ${cond.userId} explicitly asks the agent for help`;
  }
}
