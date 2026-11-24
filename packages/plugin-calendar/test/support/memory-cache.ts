// spec/calendar/linkedSync.md, "Story: Pause, resume or recover without replacing a newer sync decision"
import type { CalendarCache } from "../../src/plugin/runtime-store.vibe";

/** @throws {never} */
export function memoryCache(): CalendarCache {
  const rows = new Map<string, unknown>();
  return {
    getCache: <T>(key: string) => Promise.resolve(rows.get(key) as T | undefined),
    setCache: <T>(key: string, value: T) => Promise.resolve(rows.set(key, value) !== undefined),
    deleteCache: (key: string) => Promise.resolve(rows.delete(key)),
  };
}
