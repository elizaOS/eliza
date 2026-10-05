export type JsonStoragePort = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

/** Hosts own keys, schemas and fallback policy. Resolve storage inside each guarded
 * operation so unavailable browser storage (including its getter) cannot escape. */
export function createValidatedJsonStorage(resolve: () => JsonStoragePort) {
  return Object.freeze({
    read<T>(
      key: string,
      fallback: T,
      valid: (value: unknown) => value is T,
    ): T {
      try {
        const raw = resolve().getItem(key);
        if (raw === null) return fallback;
        const value: unknown = JSON.parse(raw);
        return valid(value) ? value : fallback;
      } catch {
        return fallback;
      }
    },
    write(key: string, value: unknown): boolean {
      try {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) return false;
        resolve().setItem(key, encoded);
        return true;
      } catch {
        return false;
      }
    },
    remove(key: string): boolean {
      try {
        resolve().removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  });
}
