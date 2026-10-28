/** Browser-safe meeting auto-join policy shapes shared by the calendar client and service. */

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

export interface MeetingAutoJoinSettings {
  policy: MeetingAutoJoinPolicy;
  updatedAt: string | null;
}
