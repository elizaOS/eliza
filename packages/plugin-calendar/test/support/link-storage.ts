// spec/calendar/linkedSync.md, "Story: Pause, resume or recover without replacing a newer sync decision"
import type { CalendarLinkStorage } from "../../src/linked-sync/index.vibe";

export function memoryLinkStorage(slots: () => Map<string, unknown>, refusing: () => boolean = () => false): CalendarLinkStorage {
  return {
    read: (slot) => Promise.resolve(structuredClone(slots().get(slot) ?? null)),
    compareExchange(slot, expected, value) {
      if (refusing() || JSON.stringify(slots().get(slot) ?? null) !== JSON.stringify(expected)) return Promise.resolve({ status: "conflict" });
      slots().set(slot, structuredClone(value));
      return Promise.resolve({ status: "saved" });
    },
  };
}
