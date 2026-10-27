/**
 * Durable drafts: one editable text value bound to an owner, agent and
 * conversation identity (the "binding") and kept in a compare-and-exchange
 * store. A draft written here survives layout changes, navigation, process
 * death and reloads, and a second window or view can never replace it
 * silently: every write names the record it replaces.
 *
 * The row holds text only. It carries no message receipts, approvals or
 * source handles, so restoring a draft never re-authorises anything. Hosts
 * own the storage namespace (installed slot or document names stay stable);
 * this module defines the row, its validation, and adapters over the two
 * store shapes hosts already have:
 *
 * - a raw compare-and-exchange slot (a native secure store, or the upstream
 *   {@link BrowserDocumentStore} through {@link browserDocumentDraftSlot}),
 * - a transactional JSON document that runs an editor once per write.
 *
 * {@link DurableDraftController} (./durable-draft-controller) drives the
 * editor lifecycle over a {@link DurableDraftStore}.
 */

import type {
  BrowserDocumentSnapshot,
  BrowserDocumentStore,
} from "../platform/browser-document-store";

/** One saved draft. `revision` changes on every write, including a clear. */
export interface DurableDraft {
  version: 1;
  binding: string;
  revision: string;
  text: string;
}

/** Default bound on a draft's UTF-8 text, in bytes. */
export const DURABLE_DRAFT_TEXT_LIMIT = 64_000;

/** The saved bytes are not a draft for this binding. Recovery is required. */
export class DurableDraftInvalid extends Error {
  constructor(message = "Saved draft needs recovery.") {
    super(message);
    this.name = "DurableDraftInvalid";
  }
}

/** Another writer replaced the draft since it was read. Nothing was written. */
export class DurableDraftConflict extends Error {
  constructor(
    message = "This draft changed in another view. Review the saved copy before replacing it.",
  ) {
    super(message);
    this.name = "DurableDraftConflict";
  }
}

/** The text exceeds the store's bound. Nothing was written. */
export class DurableDraftTooLarge extends Error {
  constructor(message = "Draft is too large to save locally.") {
    super(message);
    this.name = "DurableDraftTooLarge";
  }
}

export interface DurableDraftOptions {
  /** UTF-8 byte bound on the text (default {@link DURABLE_DRAFT_TEXT_LIMIT}). */
  textLimit?: number;
  /** Fresh revision for each write (default `crypto.randomUUID`). */
  revision?: () => string;
}

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;
const defaultRevision = (): string => crypto.randomUUID();
const DRAFT_KEYS = "binding,revision,text,version";

/**
 * Validate one stored value for `binding`. `null` (no draft) is allowed;
 * anything else that is not exactly a version-1 row for this binding throws
 * {@link DurableDraftInvalid}, so another identity's text is never adopted.
 */
export function readDurableDraft(
  value: unknown,
  binding: string,
  textLimit: number = DURABLE_DRAFT_TEXT_LIMIT,
): DurableDraft | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DurableDraftInvalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !== DRAFT_KEYS ||
    row.version !== 1 ||
    row.binding !== binding ||
    typeof row.revision !== "string" ||
    !row.revision ||
    typeof row.text !== "string" ||
    byteLength(row.text) > textLimit
  )
    throw new DurableDraftInvalid();
  return row as unknown as DurableDraft;
}

function sameDraft(a: DurableDraft | null, b: DurableDraft | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.binding === b.binding && a.revision === b.revision && a.text === b.text
  );
}

/**
 * The row that replaces `actual` with `text`, or a conflict. `expected` is
 * the record the writer last saw; any other saved state (including another
 * writer's clear) throws {@link DurableDraftConflict}. Clearing keeps a
 * revisioned empty row rather than deleting it, so an old empty receipt can
 * never match again. Unchanged text returns the saved row as is.
 */
export function replaceDurableDraft(
  actual: unknown,
  expected: DurableDraft | null,
  binding: string,
  text: string,
  options: DurableDraftOptions = {},
): DurableDraft {
  const textLimit = options.textLimit ?? DURABLE_DRAFT_TEXT_LIMIT;
  const saved = readDurableDraft(actual, binding, textLimit);
  readDurableDraft(expected, binding, textLimit);
  if (typeof text !== "string" || byteLength(text) > textLimit)
    throw new DurableDraftTooLarge();
  if (!sameDraft(saved, expected)) throw new DurableDraftConflict();
  if (saved?.text === text) return saved;
  return {
    version: 1,
    binding,
    revision: (options.revision ?? defaultRevision)(),
    text,
  };
}

/** A revisioned empty row: what a confirmed reset or a sent message leaves. */
export function emptyDurableDraft(
  binding: string,
  revision: () => string = defaultRevision,
): DurableDraft {
  return { version: 1, binding, revision: revision(), text: "" };
}

/**
 * The store a {@link DurableDraftController} edits through. `recovery` is the
 * host's own capture/reset port for damaged bytes; the controller only hands
 * it back to the host's recovery UI.
 */
export interface DurableDraftStore<Recovery = unknown> {
  recovery?: Recovery;
  read(signal?: AbortSignal): Promise<DurableDraft | null>;
  save(
    expected: DurableDraft | null,
    text: string,
    signal?: AbortSignal,
  ): Promise<DurableDraft>;
}

/** Raw bytes with an atomic compare-and-exchange, such as a native secure slot. */
export interface DurableDraftRawSlot {
  read(): Promise<string | null>;
  compareExchange(
    expected: string | null,
    value: string,
  ): Promise<{ status: "saved" | "conflict" }>;
}

export interface DurableDraftStoreOptions<Recovery>
  extends DurableDraftOptions {
  recovery?: Recovery;
}

/**
 * A draft store over a raw compare-and-exchange slot. The exchange compares
 * the exact bytes this store read or wrote, never a re-serialisation, so
 * whitespace or key order in older bytes cannot cause a false conflict or a
 * lost update. Unreadable bytes throw; nothing is rewritten until the host's
 * recovery resets them.
 */
export function compareExchangeDraftStore<Recovery = undefined>(
  binding: string,
  slot: DurableDraftRawSlot,
  options: DurableDraftStoreOptions<Recovery> = {},
): DurableDraftStore<Recovery> {
  const textLimit = options.textLimit ?? DURABLE_DRAFT_TEXT_LIMIT;
  const receipts = new WeakMap<DurableDraft, string>();
  return {
    recovery: options.recovery,
    async read(signal) {
      signal?.throwIfAborted();
      const raw = await slot.read();
      signal?.throwIfAborted();
      if (raw === null) return null;
      const row = readDurableDraft(JSON.parse(raw), binding, textLimit);
      if (row) receipts.set(row, raw);
      return row;
    },
    async save(expected, text, signal) {
      signal?.throwIfAborted();
      // The slot itself compares bytes, so the writer's own view of the row
      // stands in for the saved state here.
      const next = replaceDurableDraft(expected, expected, binding, text, {
        textLimit,
        revision: options.revision,
      });
      const expectedRaw =
        expected === null
          ? null
          : (receipts.get(expected) ?? JSON.stringify(expected));
      const nextRaw =
        next === expected && expectedRaw !== null
          ? expectedRaw
          : JSON.stringify(next);
      const receipt = await slot.compareExchange(expectedRaw, nextRaw);
      if (receipt.status !== "saved") throw new DurableDraftConflict();
      receipts.set(next, nextRaw);
      signal?.throwIfAborted();
      return next;
    },
  };
}

/**
 * A JSON document whose `editJson` runs `update` once inside one transaction
 * and writes its result, or writes nothing when `update` throws.
 */
export interface DurableDraftDocument {
  readJson(signal?: AbortSignal): Promise<unknown>;
  editJson(
    update: (actual: unknown) => unknown,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** A draft store over a transactional JSON document. */
export function transactionalDraftStore<Recovery = undefined>(
  binding: string,
  document: DurableDraftDocument,
  options: DurableDraftStoreOptions<Recovery> = {},
): DurableDraftStore<Recovery> {
  const textLimit = options.textLimit ?? DURABLE_DRAFT_TEXT_LIMIT;
  return {
    recovery: options.recovery,
    async read(signal) {
      signal?.throwIfAborted();
      const value = await document.readJson(signal);
      signal?.throwIfAborted();
      return readDurableDraft(value, binding, textLimit);
    },
    async save(expected, text, signal) {
      signal?.throwIfAborted();
      let result: DurableDraft | undefined;
      await document.editJson((actual) => {
        signal?.throwIfAborted();
        result = replaceDurableDraft(actual, expected, binding, text, {
          textLimit,
          revision: options.revision,
        });
        return result;
      }, signal);
      signal?.throwIfAborted();
      if (!result) throw new DurableDraftConflict();
      return result;
    },
  };
}

/** What a raw-slot recovery captured: the exact bytes, never re-serialised. */
export interface DurableDraftRawCapture {
  /** Opaque receipt; only this capture's reset may replace these bytes. */
  snapshot: { revision: string; raw: string | null };
  raw: string | null;
}

/**
 * Recovery for a raw slot whose bytes no longer read as a draft. `capture`
 * returns the exact saved bytes for the host's backup UI; `reset` replaces
 * exactly those bytes with an empty row, once, after the host's separate
 * confirmation. A failed read never produces reset authority, and a write by
 * anyone else since the capture refuses the reset.
 */
export function rawSlotDraftRecovery(
  binding: string,
  slot: DurableDraftRawSlot,
  options: Pick<DurableDraftOptions, "revision"> = {},
) {
  const captures = new WeakMap<object, string | null>();
  return {
    async capture(signal?: AbortSignal): Promise<DurableDraftRawCapture> {
      signal?.throwIfAborted();
      const raw = await slot.read();
      signal?.throwIfAborted();
      const snapshot = { revision: crypto.randomUUID(), raw };
      captures.set(snapshot, raw);
      return { snapshot, raw };
    },
    async reset(
      expected: { snapshot?: object | null },
      signal?: AbortSignal,
    ): Promise<void> {
      signal?.throwIfAborted();
      const snapshot = expected.snapshot;
      if (!snapshot || !captures.has(snapshot))
        throw new Error("Read the saved draft again before resetting.");
      const raw = captures.get(snapshot) ?? null;
      const receipt = await slot.compareExchange(
        raw,
        JSON.stringify(emptyDurableDraft(binding, options.revision)),
      );
      signal?.throwIfAborted();
      if (receipt.status !== "saved")
        throw new Error(
          "This draft changed in another view. Close recovery and review the saved copy.",
        );
      captures.delete(snapshot);
    },
  };
}

/**
 * A raw slot over one key of the upstream {@link BrowserDocumentStore}. A
 * missing record and a reset tombstone both read as no draft; the exchange is
 * bound to the store's own receipt, so it is atomic across windows.
 */
export function browserDocumentDraftSlot(
  documents: Pick<BrowserDocumentStore, "read" | "compareExchange">,
  key: string,
): DurableDraftRawSlot {
  return {
    async read() {
      return (await documents.read(key))?.raw ?? null;
    },
    async compareExchange(expected, value) {
      const before: BrowserDocumentSnapshot | undefined =
        await documents.read(key);
      if ((before?.raw ?? null) !== expected) return { status: "conflict" };
      try {
        await documents.compareExchange(key, before, value);
        return { status: "saved" };
      } catch (error) {
        if (error instanceof Error && error.name === "BrowserDocumentConflict")
          return { status: "conflict" };
        throw error;
      }
    },
  };
}
