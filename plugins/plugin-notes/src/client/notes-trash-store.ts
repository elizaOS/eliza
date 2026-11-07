/**
 * Notes Trash storage step: every Trash edit is validated on the way in and out, written
 * through the host's atomic edit, and then confirmed by reading it back. A write the host
 * store cannot confirm is reported as a failure, never assumed. The host supplies only its
 * durable slot (a secure credential slot, a browser document, a file) through a port; the
 * caller holds the host's Trash lock around `edit`.
 */
import type {
  NotesTrashDocument,
  NotesTrashPolicy,
  TrashNote,
  TrashTarget,
} from "./notes-trash-policy.ts";

/** A host's durable Trash slot. Values are the stored JSON documents, unvalidated. */
export interface NotesTrashStoragePort {
  read(): Promise<unknown>;
  /**
   * Atomically replace the stored value with `update(current)`. Must refuse (throw) rather
   * than overwrite a value that changed after `current` was read. `update` may run again
   * when the host retries.
   */
  edit(update: (current: unknown) => unknown): Promise<void>;
}

/** A store offering only read and compare-and-exchange (for example a Keystore-backed slot). */
export interface NotesTrashCompareExchangeSlot {
  read(): Promise<unknown>;
  /** True only when `next` replaced exactly `expected`. */
  compareExchange(expected: unknown, next: unknown): Promise<boolean>;
}

export class NotesTrashChanged extends Error {
  constructor() {
    super("Notes Trash changed");
    this.name = "NotesTrashChanged";
  }
}
export class NotesTrashUnconfirmed extends Error {
  constructor() {
    super("Notes Trash persistence unconfirmed");
    this.name = "NotesTrashUnconfirmed";
  }
}

/** Adapt a compare-and-exchange slot to the Trash port. A lost race is refused, never retried blindly. */
export function compareExchangeNotesTrashPort(
  slot: NotesTrashCompareExchangeSlot,
): NotesTrashStoragePort {
  return {
    read: () => slot.read(),
    async edit(update) {
      const current = await slot.read();
      if (!(await slot.compareExchange(current, update(current))))
        throw new NotesTrashChanged();
    },
  };
}

export interface NotesTrashStore<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
> {
  read(): Promise<NotesTrashDocument<N, T>>;
  /** Compare-and-exchange edit with readback. Callers hold the host's Trash lock. */
  edit(
    update: (current: NotesTrashDocument<N, T>) => NotesTrashDocument<N, T>,
  ): Promise<NotesTrashDocument<N, T>>;
}

export function createNotesTrashStore<
  N extends TrashNote = TrashNote,
  T extends TrashTarget = TrashTarget,
>(
  policy: Pick<NotesTrashPolicy<N, T>, "validate">,
  port: NotesTrashStoragePort,
): NotesTrashStore<N, T> {
  const read = async () => policy.validate(await port.read());
  return {
    read,
    async edit(update) {
      let written: NotesTrashDocument<N, T> | undefined;
      await port.edit((raw) => {
        written = policy.validate(update(policy.validate(raw)));
        return written;
      });
      if (
        written === undefined ||
        JSON.stringify(await read()) !== JSON.stringify(written)
      )
        throw new NotesTrashUnconfirmed();
      return written;
    },
  };
}
