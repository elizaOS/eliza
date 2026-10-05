/** An opaque document receipt. Null is a retained reset tombstone, not absence. */
export interface BrowserDocumentSnapshot {
  revision: string;
  raw: string | null;
}

export class BrowserDocumentConflict extends Error {
  constructor() {
    super("The saved document changed. Read it again before editing.");
    this.name = "BrowserDocumentConflict";
  }
}

const records = "documents";

/**
 * Transactional browser documents. The host owns namespaces, legacy import,
 * schema validation, recovery UI and notifications. No localStorage mirror is
 * maintained: a second writable authority would reintroduce lost updates.
 */
export class BrowserDocumentStore {
  constructor(private readonly databaseName: string) {
    if (!databaseName) throw new TypeError("A storage namespace is required.");
  }

  private open(signal?: AbortSignal): Promise<IDBDatabase> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      let cancelled = false;
      const abort = () => {
        cancelled = true;
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", abort);
      request.onupgradeneeded = () => {
        if (cancelled) request.transaction?.abort();
        else request.result.createObjectStore(records);
      };
      request.onblocked = () => {
        cancelled = true;
        cleanup();
        reject(new Error("Close older tabs before opening browser storage."));
      };
      request.onerror = () => {
        cleanup();
        reject(request.error);
      };
      request.onsuccess = () => {
        cleanup();
        if (cancelled) request.result.close();
        else {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        }
      };
    });
  }

  private async transact<T>(
    mode: IDBTransactionMode,
    operation: (
      store: IDBObjectStore,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const database = await this.open(signal);
    try {
      signal?.throwIfAborted();
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(records, mode);
        let value: T;
        let failure: unknown;
        const abort = () => {
          failure = signal?.reason;
          try {
            transaction.abort();
          } catch {
            // A committed transaction wins over a later cancellation.
          }
        };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        signal?.addEventListener("abort", abort, { once: true });
        transaction.oncomplete = () => {
          cleanup();
          resolve(value);
        };
        transaction.onabort = () => {
          cleanup();
          reject(
            failure ??
              transaction.error ??
              new DOMException("Write aborted", "AbortError"),
          );
        };
        try {
          operation(
            transaction.objectStore(records),
            (next) => {
              value = next;
            },
            (error) => {
              failure = error;
              transaction.abort();
            },
          );
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      });
    } finally {
      database.close();
    }
  }

  read(
    key: string,
    signal?: AbortSignal,
  ): Promise<BrowserDocumentSnapshot | undefined> {
    return this.transact(
      "readonly",
      (store, result) => {
        const request = store.get(key);
        request.onsuccess = () => result(request.result);
      },
      signal,
    );
  }

  /** Initialize absent bytes once; existing records (including tombstones) keep their receipt. */
  async readOrCreate(
    key: string,
    raw: string | null,
    signal?: AbortSignal,
  ): Promise<BrowserDocumentSnapshot> {
    if (raw !== null && typeof raw !== "string")
      throw new TypeError("Expected document bytes or null.");
    const initialize = () =>
      this.transact<BrowserDocumentSnapshot>(
        "readwrite",
        (store, result, fail) => {
          const request = store.get(key);
          request.onsuccess = () => {
            if (request.result !== undefined) {
              result(request.result);
              return;
            }
            try {
              const next = { revision: crypto.randomUUID(), raw };
              store.put(next, key);
              result(next);
            } catch (error) {
              fail(error);
            }
          };
        },
        signal,
      );
    // Share edit ownership so a first import cannot invalidate a pending editor.
    // Without Web Locks, the IndexedDB transaction still admits exactly one creator.
    return navigator.locks?.request
      ? navigator.locks.request(
          JSON.stringify(["browser-document", this.databaseName, key]),
          { mode: "exclusive", ...(signal ? { signal } : {}) },
          initialize,
        )
      : initialize();
  }

  /** Raw bytes survive corrupt JSON; reset also advances the receipt (ABA safe). */
  async compareExchange(
    key: string,
    expected: BrowserDocumentSnapshot | undefined,
    raw: string | null,
    signal?: AbortSignal,
  ): Promise<BrowserDocumentSnapshot> {
    if (raw !== null && typeof raw !== "string")
      throw new TypeError("Expected document bytes or null.");
    const next = { revision: crypto.randomUUID(), raw };
    const saved = await this.transact<boolean>(
      "readwrite",
      (store, result, fail) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const current: BrowserDocumentSnapshot | undefined = request.result;
          if (
            current?.revision !== expected?.revision ||
            current?.raw !== expected?.raw
          ) {
            result(false);
            return;
          }
          try {
            store.put(next, key);
            result(true);
          } catch (error) {
            fail(error);
          }
        };
      },
      signal,
    );
    if (!saved) throw new BrowserDocumentConflict();
    return next;
  }

  /**
   * Run a side-effect-free asynchronous editor once; never replay after conflict.
   * Cancellation releases ownership even if the editor is still awaiting work.
   * Its eventual result is discarded and cannot publish after cancellation.
   */
  async edit<R>(
    key: string,
    editor: (
      before: BrowserDocumentSnapshot | undefined,
    ) => Promise<{ raw: string | null; result: R }>,
    signal?: AbortSignal,
  ): Promise<R> {
    if (!navigator.locks?.request)
      throw new Error("Safe browser editing requires Web Locks.");
    return navigator.locks.request(
      JSON.stringify(["browser-document", this.databaseName, key]),
      { mode: "exclusive", ...(signal ? { signal } : {}) },
      async () => {
        const before = await this.read(key, signal);
        const next = await new Promise<{ raw: string | null; result: R }>(
          (resolve, reject) => {
            const abort = () => reject(signal?.reason);
            signal?.addEventListener("abort", abort, { once: true });
            Promise.resolve()
              .then(() => {
                signal?.throwIfAborted();
                return editor(before);
              })
              .then(resolve, reject)
              .finally(() => signal?.removeEventListener("abort", abort));
          },
        );
        signal?.throwIfAborted();
        await this.compareExchange(key, before, next.raw, signal);
        return next.result;
      },
    );
  }
}
