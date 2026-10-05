import { AsyncNotesStore } from "./notes-async-store.ts";
import {
  type NoteRecord,
  NotesCommitUncertain,
  type NotesStorageKeys,
  NotesStore,
} from "./notes-store.ts";
export type NotesOpenStage =
  | "native-read"
  | "legacy-import"
  | "migration-write"
  | "migration-readback"
  | "encrypted-validation"
  | "legacy-comparison"
  | "legacy-cleanup"
  | "opened";
export interface SecureNotesConfig extends NotesStorageKeys {
  secureSlot: string;
  daily: string;
}
interface LegacyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
/** Read only the legacy Notes schema; unrelated workflows/receipts do not gate Notes. */
export function readLegacyDailyNotes(
  config: SecureNotesConfig,
  storage: Pick<LegacyStorage, "getItem">,
): NoteRecord[] {
  const raw = storage.getItem(config.daily);
  if (raw === null) return [];
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.notes) ||
    value.notes.length > 10000
  )
    throw Error("Invalid legacy daily Notes");
  const ids = new Set<string>();
  return value.notes.map((note: Record<string, unknown>) => {
    if (
      !note ||
      typeof note !== "object" ||
      typeof note.id !== "string" ||
      !note.id ||
      ids.has(note.id) ||
      typeof note.title !== "string" ||
      typeof note.body !== "string" ||
      typeof note.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(note.updatedAt))
    )
      throw Error("Invalid legacy daily Note");
    ids.add(note.id);
    return {
      ...note,
      id: note.id,
      title: note.title,
      body: note.body,
      kind: "text",
      pinned: false,
      when: "Saved on this device",
    };
  });
}
export interface NotesVault {
  read<T>(key: string): Promise<T | null>;
  compareExchange(
    key: string,
    expected: unknown | null,
    value: unknown | null,
  ): Promise<{ status: string }>;
}
interface Saved {
  version: 1;
  currentRaw: string;
  archive: { v1: string | null; v2: string | null; daily: string | null };
}
function memory(
  config: SecureNotesConfig,
  raw: string | null,
  legacy: string | null = null,
) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(config.current, raw);
  if (legacy !== null) values.set(config.legacy, legacy);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Device-local collection. Native CAS is authoritative; no plaintext persistence fallback.
 * The optimistic editor snapshot is never an agent target until pending commits settle. */
export class SecureNotesStore extends AsyncNotesStore<Saved> {
  private constructor(
    config: SecureNotesConfig,
    vault: NotesVault,
    saved: Saved,
  ) {
    super(
      config,
      {
        read: () => vault.read<Saved>(config.secureSlot),
        raw: (value) => value.currentRaw,
        async compareExchange(expected, nextRaw) {
          const next = { ...expected, currentRaw: nextRaw };
          const result = await vault.compareExchange(
            config.secureSlot,
            expected,
            next,
          );
          return result.status === "saved" ? next : null;
        },
      },
      saved,
    );
  }
  static async open(
    config: SecureNotesConfig,
    vault: NotesVault,
    legacy: LegacyStorage,
    initial: NoteRecord[] | (() => NoteRecord[]) = [],
    onStage: (stage: NotesOpenStage) => void = () => {},
  ) {
    config = { ...config };
    onStage("native-read");
    let saved = await vault.read<Saved>(config.secureSlot);
    if (saved === null) {
      onStage("legacy-import");
      const archive = {
        v1: legacy.getItem(config.legacy),
        v2: legacy.getItem(config.current),
        daily: legacy.getItem(config.daily),
      };
      const inner = new NotesStore(
        config,
        memory(config, archive.v2, archive.v1),
        initial,
      );
      const proposed: Saved = { version: 1, currentRaw: inner.raw, archive };
      // Never remove source data before an acknowledged encrypted write and exact readback.
      onStage("migration-write");
      let result;
      try {
        result = await vault.compareExchange(config.secureSlot, null, proposed);
      } catch {
        throw new NotesCommitUncertain(
          "Notes migration acknowledgement was lost. Reopen to inspect the saved collection.",
        );
      }
      if (result.status !== "saved")
        throw Error("Notes migration changed in another view. Reopen Notes.");
      onStage("migration-readback");
      saved = await vault.read<Saved>(config.secureSlot);
      if (!equal(saved, proposed))
        throw new NotesCommitUncertain(
          "Encrypted Notes migration could not be verified. Original data retained.",
        );
    }
    onStage("encrypted-validation");
    if (
      !saved ||
      saved.version !== 1 ||
      typeof saved.currentRaw !== "string" ||
      !saved.archive ||
      ![saved.archive.v1, saved.archive.v2, saved.archive.daily].every(
        (value) => value === null || typeof value === "string",
      )
    )
      throw Error("Invalid encrypted Notes collection. No data changed.");
    new NotesStore(config, memory(config, saved.currentRaw));
    // Originals remain verbatim inside the encrypted archive. Delete only exact migration sources.
    onStage("legacy-comparison");
    const sources: [[string, string | null], [string, string | null]] = [
      [config.legacy, saved.archive.v1],
      [config.current, saved.archive.v2],
    ];
    for (const [key, expected] of sources) {
      const current = legacy.getItem(key);
      if (current !== null && current !== expected)
        throw Error(
          "Plaintext Notes changed during migration. Both copies retained for recovery.",
        );
    }
    // The daily record is the host's: only its `notes` were migrated. Other
    // fields (receipts, dates) may change after an interrupted migration, so
    // compare and clear `notes` alone.
    let archivedDailyNotes: unknown[] | null = null;
    if (saved.archive.daily !== null) {
      const daily = JSON.parse(saved.archive.daily);
      if (!daily || !Array.isArray(daily.notes))
        throw Error("Invalid legacy Notes archive");
      archivedDailyNotes = daily.notes;
    }
    const currentDaily = legacy.getItem(config.daily);
    if (currentDaily !== null && currentDaily !== saved.archive.daily) {
      const daily = JSON.parse(currentDaily);
      if (
        !daily ||
        !Array.isArray(daily.notes) ||
        (daily.notes.length && !equal(daily.notes, archivedDailyNotes))
      )
        throw Error(
          "Legacy Notes changed during migration. Both copies retained for recovery.",
        );
    }
    onStage("legacy-cleanup");
    for (const [key, expected] of sources)
      if (legacy.getItem(key) === expected && expected !== null)
        legacy.removeItem(key);
    const dailyNow = legacy.getItem(config.daily);
    if (archivedDailyNotes !== null && dailyNow !== null) {
      const daily = JSON.parse(dailyNow);
      if (
        Array.isArray(daily?.notes) &&
        daily.notes.length &&
        equal(daily.notes, archivedDailyNotes)
      )
        legacy.setItem(config.daily, JSON.stringify({ ...daily, notes: [] }));
    }
    if (sources.some(([key]) => legacy.getItem(key) !== null))
      throw Error(
        "Plaintext Notes cleanup did not complete. Reopen to retry cleanup.",
      );
    onStage("opened");
    return new SecureNotesStore(config, vault, saved);
  }
}
