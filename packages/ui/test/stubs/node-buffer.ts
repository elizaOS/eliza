// Stub for `node:buffer` in the Storybook browser catalog. Vite externalizes
// node builtins, so accessing `Buffer` (touched at load by core modules pulled
// via the @elizaos/shared barrel) throws. Prefer a real Buffer if a polyfill
// put one on globalThis; otherwise a minimal shim that satisfies module init.

type GlobalWithBuffer = { Buffer?: unknown };
const GlobalBuffer = (globalThis as GlobalWithBuffer).Buffer;

class BufferShim extends Uint8Array {
  static from(value: ArrayLike<number> | string): BufferShim {
    if (typeof value === "string") {
      const enc = new TextEncoder().encode(value);
      return new BufferShim(enc);
    }
    return new BufferShim(value as ArrayLike<number>);
  }
  static alloc(size: number): BufferShim {
    return new BufferShim(size);
  }
  static isBuffer(obj: unknown): boolean {
    return obj instanceof BufferShim || obj instanceof Uint8Array;
  }
  static concat(list: Uint8Array[]): BufferShim {
    const total = list.reduce((n, a) => n + a.length, 0);
    const out = new BufferShim(total);
    let offset = 0;
    for (const a of list) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }
  toString(): string {
    return new TextDecoder().decode(this);
  }
}

export const Buffer = (GlobalBuffer as typeof BufferShim) ?? BufferShim;
export const constants = { MAX_LENGTH: 0, MAX_STRING_LENGTH: 0 };
export const kMaxLength = 0;
export const INSPECT_MAX_BYTES = 50;
export const SlowBuffer = Buffer;
export const Blob = (globalThis as { Blob?: unknown }).Blob;
export const File = (globalThis as { File?: unknown }).File;
export const atob = (s: string) => globalThis.atob(s);
export const btoa = (s: string) => globalThis.btoa(s);

export default {
  Buffer,
  SlowBuffer,
  constants,
  kMaxLength,
  INSPECT_MAX_BYTES,
  Blob,
  File,
  atob,
  btoa,
};
