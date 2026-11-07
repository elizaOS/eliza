/**
 * Persists the per-agent policy for automatically joining meetings discovered
 * from calendar events. The policy is stored in runtime cache, keeping the
 * calendar package independent from LifeOps scheduler state while preserving
 * the owner-visible off/ask/all behavior.
 */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  MeetingAutoJoinPolicy,
  MeetingAutoJoinSettings,
} from "./auto-join-types.js";

export type {
  MeetingAutoJoinPolicy,
  MeetingAutoJoinSettings,
} from "./auto-join-types.js";

export const MEETING_AUTO_JOIN_POLICIES: readonly MeetingAutoJoinPolicy[] = [
  "off",
  "ask",
  "all",
];

export const DEFAULT_MEETING_AUTO_JOIN_POLICY: MeetingAutoJoinPolicy = "off";

const MEETING_AUTO_JOIN_CACHE_KEY = "calendar:meeting-auto-join";

export function isMeetingAutoJoinPolicy(
  value: unknown,
): value is MeetingAutoJoinPolicy {
  return (
    typeof value === "string" &&
    (MEETING_AUTO_JOIN_POLICIES as readonly string[]).includes(value)
  );
}

function resolveSettings(value: unknown): MeetingAutoJoinSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { policy: DEFAULT_MEETING_AUTO_JOIN_POLICY, updatedAt: null };
  }
  const record = value as Record<string, unknown>;
  return {
    policy: isMeetingAutoJoinPolicy(record.policy)
      ? record.policy
      : DEFAULT_MEETING_AUTO_JOIN_POLICY,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

export async function readMeetingAutoJoinSettings(
  runtime: IAgentRuntime,
): Promise<MeetingAutoJoinSettings> {
  const cached = await runtime.getCache<unknown>(MEETING_AUTO_JOIN_CACHE_KEY);
  return resolveSettings(cached);
}

export async function writeMeetingAutoJoinPolicy(
  runtime: IAgentRuntime,
  policy: MeetingAutoJoinPolicy,
): Promise<MeetingAutoJoinSettings> {
  const next: MeetingAutoJoinSettings = {
    policy,
    updatedAt: new Date().toISOString(),
  };
  await runtime.setCache(MEETING_AUTO_JOIN_CACHE_KEY, next);
  return next;
}
