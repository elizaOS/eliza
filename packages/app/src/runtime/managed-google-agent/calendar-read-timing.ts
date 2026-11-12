import type { ManagedGoogleRequest } from "./managed-google-client.ts";

export type CalendarCacheBucket = "owner-cache" | "calendars-cache";
type RouteBucket = "identity" | "accounts" | "calendars" | "feed";
export type CalendarReadTiming =
  | {
      version: 1;
      routeBucket: RouteBucket;
      status: number | null;
      durationMs: number;
    }
  | {
      version: 1;
      routeBucket: CalendarCacheBucket;
      cacheHit: "miss" | "in-flight" | "completed";
      ageMs: number | null;
    };
const routes: Record<string, RouteBucket> = {
  "/api/v1/user": "identity",
  "/api/v1/eliza/google/accounts": "accounts",
  "/api/v1/eliza/google/calendar/calendars": "calendars",
  "/api/v1/eliza/google/calendar/feed": "feed",
};
const rounded = (n: number) =>
  Number.isFinite(n)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(n)))
    : 0;
/** Private host diagnostic only. Cost: one fixed-field line per existing RPC or cache lookup,
 * zero additional I/O requests. Disabled by default; never records URLs, identities or data.
 */
export function createCalendarReadTiming(
  enabled: boolean,
  emit: (value: CalendarReadTiming) => void = (value) =>
    console.info("[alpha-calendar-read-timing]", JSON.stringify(value)),
) {
  const record = (value: CalendarReadTiming) => {
    try {
      emit(value);
    } catch {
      /* Diagnostics cannot change reads or errors. */
    }
  };
  return {
    request(read: ManagedGoogleRequest): ManagedGoogleRequest {
      if (!enabled) return read;
      return async (input) => {
        let bucket: RouteBucket | undefined;
        try {
          if (input.method === "GET")
            bucket = routes[new URL(input.url).pathname];
        } catch {
          /* Transport retains invalid URL handling. */
        }
        if (!bucket) return read(input);
        const start = performance.now();
        let status: number | null = null;
        try {
          const result = await read(input);
          status =
            Number.isInteger(result.status) &&
            result.status >= 100 &&
            result.status <= 599
              ? result.status
              : null;
          return result;
        } finally {
          record({
            version: 1,
            routeBucket: bucket,
            status,
            durationMs: rounded(performance.now() - start),
          });
        }
      };
    },
    cache(
      routeBucket: CalendarCacheBucket,
      cacheHit: "miss" | "in-flight" | "completed",
      ageMs: number | null,
    ) {
      if (enabled)
        record({
          version: 1,
          routeBucket,
          cacheHit,
          ageMs: ageMs === null ? null : rounded(ageMs),
        });
    },
  };
}
