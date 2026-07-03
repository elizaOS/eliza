import type { IAgentRuntime } from "@elizaos/core";

/**
 * Per-agent meeting auto-join policy.
 *
 * - `"off"`  — never schedule the agent into meetings automatically (default).
 * - `"ask"`  — schedule an approval task shortly before each recognized
 *              meeting; the agent joins only after the owner approves.
 * - `"all"`  — join every synced calendar event with a recognized
 *              Meet/Teams/Zoom conference link at event start.
 *
 * Persisted in the runtime cache, the same surface the calendar plugin uses
 * for its feed-inclusion preferences (`feed-preferences.ts`).
 */
export type MeetingAutoJoinPolicy = "off" | "ask" | "all";

export const MEETING_AUTO_JOIN_POLICIES: readonly MeetingAutoJoinPolicy[] = [
  "off",
  "ask",
  "all",
];

export const DEFAULT_MEETING_AUTO_JOIN_POLICY: MeetingAutoJoinPolicy = "off";

export interface MeetingAutoJoinSettings {
  policy: MeetingAutoJoinPolicy;
  updatedAt: string | null;
}

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
