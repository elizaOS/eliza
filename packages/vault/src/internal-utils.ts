import type { SetOptions } from "./vault.js";

export function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("vault: key must be a non-empty string");
  }
  if (key.length > 256) {
    throw new TypeError("vault: key must be 256 characters or fewer");
  }
}

export function optsCaller(opts: SetOptions): { caller?: string } {
  return opts.caller ? { caller: opts.caller } : {};
}
