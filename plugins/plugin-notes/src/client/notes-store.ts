import {
  type NotesOperation,
  type NotesResult,
  type NotesTarget,
  notesFields,
  validateNotesOperation,
  validateNotesResult,
} from "./notes-contract.ts";
export interface NotesStorageKeys {
  current: string;
  legacy: string;
}
export class NotesCommitUncertain extends Error {}

export interface NoteRecord {
  id: string;
  kind: string;
  title: string;
  body?: string;
  [key: string]: unknown;
}
interface Envelope {
  version: 2;
  collectionId: string;
  records: NoteRecord[];
  deleted: Array<{ id: string; revision: string; operationId: string }>;
}
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
function records(value: unknown): NoteRecord[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw Error("Invalid saved Notes");
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.title !== "string" ||
      !["text", "list", "voice", "link"].includes(item.kind)
    )
      throw Error("Invalid saved Note");
    ids.add(item.id);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
}
/** One authoritative versioned envelope. The original v1 key is preserved verbatim. */
export class NotesStore {
  raw = "";
  private envelope!: Envelope;
  constructor(
    private keys: NotesStorageKeys,
    private storage: StoragePort,
    initial: NoteRecord[] | (() => NoteRecord[]) = [],
  ) {
    this.keys = { ...keys };
    const current = storage.getItem(this.keys.current);
    if (current === null) {
      const legacy = storage.getItem(this.keys.legacy);
      const list = records(
        legacy === null
          ? typeof initial === "function"
            ? initial()
            : initial
          : JSON.parse(legacy),
      );
      const next: Envelope = {
        version: 2,
        collectionId: crypto.randomUUID(),
        records: list,
        deleted: [],
      };
      const encoded = JSON.stringify(next);
      if (storage.getItem(this.keys.current) !== null)
        throw Error("Notes migration raced");
      storage.setItem(this.keys.current, encoded);
      if (storage.getItem(this.keys.current) !== encoded)
        throw Error("Notes migration not committed");
      this.load(encoded);
    } else this.load(current);
  }
  private load(raw: string) {
    const e = JSON.parse(raw);
    if (
      !e ||
      e.version !== 2 ||
      typeof e.collectionId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(e.collectionId) ||
      !Array.isArray(e.deleted)
    )
      throw Error("Invalid Notes envelope");
    records(e.records);
    this.envelope = e;
    this.raw = raw;
  }
  get list() {
    return structuredClone(this.envelope.records);
  }
  assertCurrent() {
    if (this.storage.getItem(this.keys.current) !== this.raw)
      throw Error(
        "Notes changed in another view. Reopen Notes before editing.",
      );
  }
  replace(list: NoteRecord[], deleted = this.envelope.deleted) {
    this.assertCurrent();
    records(list);
    const raw = JSON.stringify({ ...this.envelope, records: list, deleted });
    try {
      this.storage.setItem(this.keys.current, raw);
      if (this.storage.getItem(this.keys.current) !== raw)
        throw Error("readback mismatch");
      this.load(raw);
    } catch {
      throw new NotesCommitUncertain(
        "Notes commit outcome is unknown; do not repeat the edit.",
      );
    }
  }
  async target(noteId: string): Promise<NotesTarget> {
    this.assertCurrent();
    const note = this.envelope.records.find((n) => n.id === noteId);
    if (!note) throw Error("Selected note is missing");
    const target = {
      sourceId: this.envelope.collectionId,
      sourceRevision: await hash([
        "notes.local-record.v1",
        this.envelope.collectionId,
      ]),
      noteId,
      revision: await hash([this.envelope.collectionId, note]),
    };
    this.assertCurrent();
    if (
      this.envelope.collectionId !== target.sourceId ||
      canonical(this.envelope.records.find((n) => n.id === noteId)) !==
        canonical(note)
    )
      throw Error("Selected note changed");
    return target;
  }
  async execute(
    input: NotesOperation,
    operationId: string,
    signal: AbortSignal,
    assertAuthorized: () => void,
  ): Promise<NotesResult> {
    const op = validateNotesOperation(input);
    signal.throwIfAborted();
    assertAuthorized();
    const raw = this.raw,
      target = await this.target(op.target.noteId);
    if (canonical(target) !== canonical(op.target))
      throw Error("Selected note revision changed");
    const original = this.envelope.records.find((n) => n.id === target.noteId);
    if (!original) throw Error("Selected note changed");
    // v1 can read transcript text, but cannot silently turn a list/voice/link into a text note.
    if (op.type === "notes_update" && original.kind !== "text")
      throw Error(
        "Only text Notes support agent edits; use the native editor for this note kind",
      );
    let result: NotesResult = {
      version: 1,
      kind: op.type,
      sourceId: target.sourceId,
      noteId: target.noteId,
      revision: target.revision,
    };
    let list = this.list,
      deleted = this.envelope.deleted;
    if (op.type === "notes_read_selected")
      result.fields = notesFields({
        title: original.title,
        body: original.body,
      });
    if (op.type === "notes_update") {
      const next: NoteRecord = { ...original, ...op.fields };
      if (next.title !== original.title || next.body !== original.body)
        next.modifiedAt = Date.now();
      result.revision = await hash([this.envelope.collectionId, next]);
      list = list.map((n) => (n.id === target.noteId ? next : n));
    }
    if (op.type === "notes_delete") {
      list = list.filter((n) => n.id !== target.noteId);
      deleted = [
        ...deleted,
        { id: target.noteId, revision: target.revision, operationId },
      ];
    }
    signal.throwIfAborted();
    assertAuthorized();
    this.assertCurrent();
    if (this.raw !== raw)
      throw Error("Notes changed before the approved operation");
    result = validateNotesResult(op, result);
    // No async work after mutation and before returning its exact receipt.
    if (op.type !== "notes_read_selected") this.replace(list, deleted);
    return result;
  }
}
