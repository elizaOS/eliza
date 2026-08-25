/**
 * Exercises the Vitest-only bun:ffi stub: FFIType constants, CString,
 * ptr(), and dlopen()'s no-op symbol proxy. The real bun:ffi builtin is
 * unavailable under Node/Vite, so this suite drives the stub module
 * itself rather than the native implementation.
 */
import { describe, expect, it } from "vitest";
import { CString, dlopen, FFIType, type Pointer, ptr } from "./bun-ffi.ts";

describe("FFIType", () => {
  it("assigns distinct sequential integer tags", () => {
    expect(FFIType).toEqual({
      ptr: 0,
      bool: 1,
      f64: 2,
      i32: 3,
      cstring: 4,
      void: 5,
    });
    expect(new Set(Object.values(FFIType)).size).toBe(6);
  });

  it("exposes only the documented keys", () => {
    expect(Object.keys(FFIType).sort()).toEqual(
      ["bool", "cstring", "f64", "i32", "ptr", "void"].sort(),
    );
  });
});

describe("CString", () => {
  it("is constructible from any pointer-shaped value", () => {
    expect(new CString(0)).toBeInstanceOf(CString);
    expect(new CString(null)).toBeInstanceOf(CString);
    expect(new CString(undefined)).toBeInstanceOf(CString);
    expect(new CString({})).toBeInstanceOf(CString);
  });

  it("stringifies to an empty string regardless of the stored pointer", () => {
    expect(new CString(0).toString()).toBe("");
    expect(new CString(1).toString()).toBe("");
    expect(new CString("not-a-pointer").toString()).toBe("");
    expect(new CString(null).toString()).toBe("");
    expect(new CString(undefined).toString()).toBe("");
    expect(new CString({ addr: 42 }).toString()).toBe("");
  });
});

describe("ptr", () => {
  it("returns the zero pointer for every ArrayBufferView", () => {
    const views: ArrayBufferView[] = [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      new Int32Array([9]),
      new Float64Array([1.5]),
      new DataView(new ArrayBuffer(8)),
    ];
    for (const view of views) {
      const p: Pointer = ptr(view);
      expect(p).toBe(0);
    }
  });
});

describe("dlopen", () => {
  it("returns a handle with a close method and a symbols object", () => {
    const handle = dlopen("/tmp/missing.dylib", {});
    expect(typeof handle.close).toBe("function");
    expect(handle.symbols).toEqual({});
    expect(handle.close()).toBeUndefined();
  });

  it("ignores the library path and the declared symbol table", () => {
    const empty = dlopen("", {});
    const named = dlopen("/does/not/exist.so", {
      create_window: { args: [], returns: FFIType.void },
    });
    expect(empty.symbols.create_window()).toBe(false);
    expect(named.symbols.create_window()).toBe(false);
    expect(named.symbols.never_declared()).toBe(false);
  });

  it("returns false from every proxied symbol, including missing names", () => {
    const { symbols } = dlopen("libtest", { open: {}, close: {} });
    expect(symbols.open()).toBe(false);
    expect(symbols.close()).toBe(false);
    expect(symbols.missing()).toBe(false);
    expect(symbols.open("arg", 1, { nested: true })).toBe(false);
  });

  it("yields a fresh function on each symbols property access", () => {
    const { symbols } = dlopen("libtest", { once: {} });
    const first = symbols.once;
    const second = symbols.once;
    expect(typeof first).toBe("function");
    expect(typeof second).toBe("function");
    expect(first).not.toBe(second);
    expect(first()).toBe(false);
    expect(second()).toBe(false);
  });

  it("does not throw when close is called more than once", () => {
    const handle = dlopen("libtest", {});
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });
});
