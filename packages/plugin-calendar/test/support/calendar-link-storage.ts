import type { CalendarLinkStorage } from "../../src/linked-sync/index.vibe";

export function memoryCalendarLinkStorage(refuseWrites: () => boolean = () => false): CalendarLinkStorage & { reset(): void } {
  const slots = new Map<string, unknown>();
  return {
    read: (slot) => new Promise((resolve) => {
      resolve(structuredClone(slots.get(slot) ?? null));
    }),
    compareExchange: (slot, expected, value) => new Promise((resolve) => {
      if (refuseWrites() || JSON.stringify(slots.get(slot) ?? null) !== JSON.stringify(expected)) {
        resolve({ status: "conflict" });
        return;
      }
      slots.set(slot, structuredClone(value));
      resolve({ status: "saved" });
    }),
    reset: () => slots.clear(),
  };
}
