import { describe, expect, it } from "vitest";
import {
  type ClockHandoffHistoryStorage,
  type ClockHandoffRecord,
  createClockHandoffHistory,
  validateClockHandoffRecord,
} from "./clock-handoff-history.ts";

function memoryStorage() {
  const slots = new Map<string, unknown>();
  const storage: ClockHandoffHistoryStorage = {
    async read<T>(slot: string) {
      return slots.has(slot) ? (structuredClone(slots.get(slot)) as T) : null;
    },
    async compareExchange(slot, expected, value) {
      const current = slots.has(slot) ? slots.get(slot) : null;
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        return { status: "conflict" };
      }
      if (value === null) slots.delete(slot);
      else slots.set(slot, structuredClone(value));
      return { status: "saved" };
    },
  };
  return { slots, storage };
}

const record = (
  status: ClockHandoffRecord["status"],
  id = "op-1",
): ClockHandoffRecord => ({
  id,
  action: "set",
  status,
  at: "2026-10-28T07:00:00.000Z",
});

describe("clock handoff history", () => {
  it("starts empty and saves a record behind compare-and-set", async () => {
    const { storage } = memoryStorage();
    const history = createClockHandoffHistory({ storage, slot: "clock" });
    const empty = await history.read();
    expect(empty).toEqual({ stored: null, legacy: null, record: null });
    const opening = await history.save(empty, record("opening"));
    expect(opening.record?.status).toBe("opening");
    const opened = await history.save(opening, record("opened"));
    expect(opened.record?.status).toBe("opened");
  });

  it("refuses a stale snapshot instead of overwriting a newer record", async () => {
    const { storage } = memoryStorage();
    const history = createClockHandoffHistory({ storage, slot: "clock" });
    const empty = await history.read();
    await history.save(empty, record("opening", "op-a"));
    await expect(
      history.save(empty, record("opening", "op-b")),
    ).rejects.toThrow("Clock handoff history changed");
    expect((await history.read()).record?.id).toBe("op-a");
  });

  it("reads a legacy copy and refuses when an older app changes it", async () => {
    const { storage } = memoryStorage();
    let legacy: string | null = JSON.stringify(record("opened", "old"));
    const history = createClockHandoffHistory({
      storage,
      slot: "clock",
      legacy: () => legacy,
    });
    const first = await history.read();
    expect(first.record?.id).toBe("old");
    const saved = await history.save(first, record("opening", "new"));
    expect(saved.stored?.legacy).toBe(legacy);
    legacy = JSON.stringify(record("failed", "older-app"));
    await expect(history.read()).rejects.toThrow("changed in an older app");
    await expect(history.save(saved, record("opened", "new"))).rejects.toThrow(
      "Clock handoff history changed",
    );
  });

  it("rejects unreadable records and envelopes", async () => {
    expect(() =>
      validateClockHandoffRecord({ ...record("opened"), alarmId: "x" }),
    ).toThrow("unreadable");
    expect(() =>
      validateClockHandoffRecord({ ...record("opened"), status: "ringing" }),
    ).toThrow("unreadable");
    expect(() =>
      validateClockHandoffRecord({ ...record("opened"), at: "not a date" }),
    ).toThrow("unreadable");
    const { slots, storage } = memoryStorage();
    slots.set("clock", { version: 2, legacy: null, record: record("opened") });
    const history = createClockHandoffHistory({ storage, slot: "clock" });
    await expect(history.read()).rejects.toThrow("unreadable");
  });

  it("reports an unconfirmed save when the readback differs", async () => {
    const { storage } = memoryStorage();
    const lossy: ClockHandoffHistoryStorage = {
      read: storage.read,
      async compareExchange() {
        return { status: "saved" };
      },
    };
    const history = createClockHandoffHistory({
      storage: lossy,
      slot: "clock",
    });
    await expect(
      history.save(await history.read(), record("opening")),
    ).rejects.toThrow("Clock handoff save unconfirmed");
  });
});
