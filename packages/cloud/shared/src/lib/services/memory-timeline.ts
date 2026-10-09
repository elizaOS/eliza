/**
 * Day bucket for a memory timeline. A created time of epoch is 1970-01-01.
 * `createdAt || Date.now()` counted that memory on the day the analysis ran.
 */
export function memoryTimelineDate(createdAt: number | undefined, now = Date.now()): Date {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return new Date(createdAt);
  return new Date(now);
}
