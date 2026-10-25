import { type ScanTextLine, validateScanTextLayer } from "./scan-text-layer.ts";
export type ScanDraft = {
  id: "document";
  revision: string;
  pages: Blob[];
  textLayers?: (ScanTextLine[] | null)[];
  updated: number;
};
type StoredScanDraft = Omit<ScanDraft, "pages"> & {
  pages: { bytes: ArrayBuffer; type: string }[];
  format: 2;
};
function decode(value: unknown): ScanDraft {
  const draft = value as Partial<StoredScanDraft>;
  if (
    !draft ||
    draft.id !== "document" ||
    typeof draft.revision !== "string" ||
    !draft.revision ||
    typeof draft.updated !== "number" ||
    !Number.isFinite(draft.updated) ||
    !Array.isArray(draft.pages) ||
    (draft.format !== undefined && draft.format !== 2)
  )
    throw Error("Saved draft could not be read.");
  const pages = draft.pages.map((page: unknown) => {
    if (draft.format === undefined && page instanceof Blob) return page;
    const item = page as { bytes?: unknown; type?: unknown };
    if (
      draft.format !== 2 ||
      !item ||
      !(item.bytes instanceof ArrayBuffer) ||
      typeof item.type !== "string"
    )
      throw Error("Saved page could not be read.");
    return new Blob([item.bytes], { type: item.type });
  });
  valid(pages);
  return {
    id: "document",
    revision: draft.revision,
    pages,
    textLayers: copyScanTextLayers(draft.textLayers, pages.length),
    updated: draft.updated,
  };
}
export function copyScanTextLayers(
  input: (ScanTextLine[] | null)[] | undefined,
  count: number,
) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length !== count)
    throw Error("Saved text does not match the document pages.");
  return input.map((lines) => {
    if (lines === null) return null;
    validateScanTextLayer(lines);
    return lines.map(({ text, x, y, width, height }) => ({
      text,
      x,
      y,
      width,
      height,
    }));
  });
}
function valid(pages: Blob[]) {
  if (
    !Array.isArray(pages) ||
    pages.length < 1 ||
    pages.length > 20 ||
    pages.some(
      (p) =>
        !(p instanceof Blob) ||
        !["image/jpeg", "image/png", "image/webp"].includes(p.type) ||
        !p.size ||
        p.size > 16 * 1024 * 1024,
    ) ||
    pages.reduce((sum, p) => sum + p.size, 0) > 64 * 1024 * 1024
  )
    throw Error("Choose 1 to 20 images, up to 64 MB total.");
}
export function createScanDraftStore(databaseName: string) {
  async function transaction<T>(
    mode: IDBTransactionMode,
    action: (
      store: IDBObjectStore,
      set: (value: T) => void,
      fail: (error: Error) => void,
    ) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(databaseName, 1);
      r.onupgradeneeded = () =>
        r.result.createObjectStore("drafts", { keyPath: "id" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () =>
        reject(Error("Close another scan tab and try again."));
    });
    return new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", mode);
      let value: T, error: Error | undefined;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        db.close();
      };
      tx.oncomplete = () => {
        cleanup();
        resolve(value);
      };
      tx.onabort = tx.onerror = () => {
        cleanup();
        reject(error ?? tx.error ?? Error("Draft storage interrupted."));
      };
      const fail = (reason: Error) => {
        error = reason;
        tx.abort();
      };
      const abort = () =>
        fail(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      try {
        signal?.throwIfAborted();
        action(tx.objectStore("drafts"), (v) => (value = v), fail);
      } catch (e) {
        fail(e as Error);
      }
    });
  }
  async function readScanDraft() {
    const draft = await transaction<unknown>("readonly", (store, set) => {
      const r = store.get("document");
      r.onsuccess = () => set(r.result);
    });
    return draft === undefined ? undefined : decode(draft);
  }
  async function saveScanDraft(
    pages: Blob[],
    expected: string | undefined,
    signal: AbortSignal,
    textLayers?: (ScanTextLine[] | null)[],
  ) {
    signal.throwIfAborted();
    pages = [...pages];
    valid(pages);
    textLayers = copyScanTextLayers(textLayers, pages.length);
    // Read before opening the transaction: awaits must not let IndexedDB auto-commit.
    const stored: StoredScanDraft["pages"] = [];
    for (const page of pages) {
      const bytes = await page.arrayBuffer();
      signal.throwIfAborted();
      if (bytes.byteLength !== page.size)
        throw Error("Could not read the complete page.");
      stored.push({ bytes, type: page.type });
    }
    return transaction<ScanDraft>(
      "readwrite",
      (store, set, fail) => {
        const r = store.get("document");
        r.onsuccess = () => {
          try {
            signal.throwIfAborted();
            const old = r.result === undefined ? undefined : decode(r.result);
            if (old?.revision !== expected)
              throw Error(
                "A saved draft already exists or changed. Load the saved draft before replacing it.",
              );
            const draft: ScanDraft = {
              id: "document",
              revision: crypto.randomUUID(),
              pages,
              textLayers,
              updated: Date.now(),
            };
            store.put({
              ...draft,
              format: 2,
              pages: stored,
            } satisfies StoredScanDraft);
            set(draft);
          } catch (error) {
            fail(error as Error);
          }
        };
      },
      signal,
    );
  }
  async function deleteScanDraft(expected: string, signal: AbortSignal) {
    return transaction<void>(
      "readwrite",
      (store, set, fail) => {
        const r = store.get("document");
        r.onsuccess = () => {
          try {
            signal.throwIfAborted();
            if (r.result?.revision !== expected)
              throw Error("Saved draft changed. Load it before deleting.");
            store.delete("document");
            set(undefined);
          } catch (error) {
            fail(error as Error);
          }
        };
      },
      signal,
    );
  }

  return { readScanDraft, saveScanDraft, deleteScanDraft };
}
