/**
 * Device-local record of the latest reviewed Clock handoff.
 *
 * Android Clock owns alarms. This record is not an alarm database and not a replay
 * journal: it remembers only the last handoff the owner reviewed and whether Clock
 * opened, so a host can show "Clock request sent" or "Clock did not open" after a
 * restart without claiming that an alarm exists, changed or rang. It never dispatches.
 *
 * Hosts bind it to a compare-and-set storage slot. A host that once kept the record
 * under an older plain key passes a `legacy` reader: the stored envelope remembers the
 * legacy bytes it superseded, and a later read refuses when an older app build changed
 * them, instead of silently picking one copy.
 */

export const CLOCK_HANDOFF_HISTORY_ACTIONS = [
  "set",
  "show",
  "snooze",
  "dismiss",
] as const;
export const CLOCK_HANDOFF_HISTORY_STATUSES = [
  "opening",
  "opened",
  "unavailable",
  "denied",
  "failed",
  "unknown",
] as const;

export interface ClockHandoffRecord {
  id: string;
  action: (typeof CLOCK_HANDOFF_HISTORY_ACTIONS)[number];
  status: (typeof CLOCK_HANDOFF_HISTORY_STATUSES)[number];
  /** ISO timestamp of the record. */
  at: string;
}

export interface ClockHandoffEnvelope {
  version: 1;
  legacy: string | null;
  record: ClockHandoffRecord;
}

export interface ClockHandoffSnapshot {
  stored: ClockHandoffEnvelope | null;
  legacy: string | null;
  record: ClockHandoffRecord | null;
}

/** Compare-and-set slot storage, for example a secure preferences slot. */
export interface ClockHandoffHistoryStorage {
  read<T>(slot: string): Promise<T | null>;
  compareExchange(
    slot: string,
    expected: unknown | null,
    value: unknown | null,
  ): Promise<{ status: "saved" | "conflict" | string }>;
}

export interface ClockHandoffHistoryOptions {
  storage: ClockHandoffHistoryStorage;
  slot: string;
  /** Reads an older plain copy of the record, or null when the host never had one. */
  legacy?: () => string | null;
}

export interface ClockHandoffHistory {
  read(): Promise<ClockHandoffSnapshot>;
  save(
    expected: ClockHandoffSnapshot,
    value: ClockHandoffRecord,
  ): Promise<ClockHandoffSnapshot>;
}

const RECORD_KEYS = ["id", "action", "status", "at"];
const ENVELOPE_KEYS = ["version", "legacy", "record"];

/** Validates one record exactly; throws on any extra field or unknown value. */
export function validateClockHandoffRecord(value: unknown): ClockHandoffRecord {
  const row = value as ClockHandoffRecord;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    typeof row.id !== "string" ||
    !row.id ||
    row.id.length > 100 ||
    !(CLOCK_HANDOFF_HISTORY_ACTIONS as readonly string[]).includes(
      row.action,
    ) ||
    !(CLOCK_HANDOFF_HISTORY_STATUSES as readonly string[]).includes(
      row.status,
    ) ||
    typeof row.at !== "string" ||
    !Number.isFinite(Date.parse(row.at)) ||
    Object.keys(row).some((key) => !RECORD_KEYS.includes(key))
  ) {
    throw new Error("Clock handoff history is unreadable");
  }
  return row;
}

export function createClockHandoffHistory(
  options: ClockHandoffHistoryOptions,
): ClockHandoffHistory {
  const { storage, slot } = options;
  const legacy = options.legacy ?? (() => null);
  const read = async (): Promise<ClockHandoffSnapshot> => {
    const stored = await storage.read<ClockHandoffEnvelope>(slot);
    const raw = legacy();
    if (stored === null) {
      return {
        stored,
        legacy: raw,
        record:
          raw === null ? null : validateClockHandoffRecord(JSON.parse(raw)),
      };
    }
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      stored.version !== 1 ||
      !(stored.legacy === null || typeof stored.legacy === "string") ||
      Object.keys(stored).some((key) => !ENVELOPE_KEYS.includes(key))
    ) {
      throw new Error("Clock handoff history is unreadable");
    }
    if (stored.legacy !== raw) {
      throw new Error("Clock handoff history changed in an older app");
    }
    return {
      stored,
      legacy: raw,
      record: validateClockHandoffRecord(stored.record),
    };
  };
  const save = async (
    expected: ClockHandoffSnapshot,
    value: ClockHandoffRecord,
  ): Promise<ClockHandoffSnapshot> => {
    validateClockHandoffRecord(value);
    if (legacy() !== expected.legacy) {
      throw new Error("Clock handoff history changed");
    }
    const next: ClockHandoffEnvelope = {
      version: 1,
      legacy: expected.legacy,
      record: value,
    };
    if (
      (await storage.compareExchange(slot, expected.stored, next)).status !==
      "saved"
    ) {
      throw new Error("Clock handoff history changed");
    }
    const saved = await read();
    if (JSON.stringify(saved.stored) !== JSON.stringify(next)) {
      throw new Error("Clock handoff save unconfirmed");
    }
    return saved;
  };
  return { read, save };
}
