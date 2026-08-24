/**
 * Exercises `ensureElectrobunGlobal` against a real `window` object: missing
 * and explicit-undefined globals, already-defined values (including `null`),
 * idempotent re-entry, and the installed no-op message handlers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ensureElectrobunGlobal } from "../electrobun-stub.ts";

afterEach(() => {
  // @ts-expect-error cleanup
  delete globalThis.window;
});

type ElectrobunHandlers = {
  receiveMessageFromBun: (m: unknown) => unknown;
  receiveInternalMessageFromBun: (m: unknown) => unknown;
};

type ElectrobunTestWindow = {
  __electrobun?: ElectrobunHandlers | null;
};

function makeWindow(): ElectrobunTestWindow {
  const w: ElectrobunTestWindow = {};
  (globalThis as { window?: Window }).window = w as Window;
  return w;
}

describe("ensureElectrobunGlobal", () => {
  it("creates the global when missing", () => {
    const w = makeWindow();
    ensureElectrobunGlobal();
    expect(typeof w.__electrobun?.receiveMessageFromBun).toBe("function");
    expect(typeof w.__electrobun?.receiveInternalMessageFromBun).toBe(
      "function",
    );
  });

  it("creates the global when the property is explicitly undefined", () => {
    const w = makeWindow();
    w.__electrobun = undefined;
    ensureElectrobunGlobal();
    const installed = w.__electrobun as ElectrobunHandlers | null | undefined;
    expect(typeof installed?.receiveMessageFromBun).toBe("function");
    expect(typeof installed?.receiveInternalMessageFromBun).toBe("function");
  });

  it("leaves an existing global untouched", () => {
    const w = makeWindow();
    const existing = {
      receiveMessageFromBun: () => "keep",
      receiveInternalMessageFromBun: () => "keep",
    };
    w.__electrobun = existing;
    ensureElectrobunGlobal();
    expect(w.__electrobun).toBe(existing);
  });

  it("is idempotent and keeps the same stub object on a second call", () => {
    const w = makeWindow();
    ensureElectrobunGlobal();
    const first = w.__electrobun;
    ensureElectrobunGlobal();
    expect(w.__electrobun).toBe(first);
  });

  it("leaves a null placeholder untouched because typeof null is object", () => {
    const w = makeWindow();
    w.__electrobun = null;
    ensureElectrobunGlobal();
    expect(w.__electrobun).toBeNull();
  });

  it("installed handlers accept a message and return undefined without throwing", () => {
    const w = makeWindow();
    ensureElectrobunGlobal();
    const bun = w.__electrobun;
    if (bun === undefined || bun === null) {
      throw new Error("ensureElectrobunGlobal did not install the stub");
    }
    expect(bun.receiveMessageFromBun("payload")).toBeUndefined();
    expect(
      bun.receiveInternalMessageFromBun({ kind: "internal" }),
    ).toBeUndefined();
  });

  it("leaves falsy non-undefined placeholders untouched", () => {
    for (const placeholder of [false, 0, ""] as const) {
      const w = makeWindow();
      (w as { __electrobun?: unknown }).__electrobun = placeholder;
      ensureElectrobunGlobal();
      expect(w.__electrobun).toBe(placeholder);
    }
  });

  it("leaves a partial stub untouched instead of completing its handlers", () => {
    const w = makeWindow();
    const partial = { receiveMessageFromBun: () => "partial" };
    (w as { __electrobun?: unknown }).__electrobun = partial;
    ensureElectrobunGlobal();
    expect(w.__electrobun).toBe(partial);
    const installed = w.__electrobun;
    if (installed === null || installed === undefined) {
      throw new Error("ensureElectrobunGlobal replaced an existing stub");
    }
    expect(installed.receiveInternalMessageFromBun).toBeUndefined();
  });

  it("reinstalls a fresh stub after the global was deleted", () => {
    const w = makeWindow();
    ensureElectrobunGlobal();
    const first = w.__electrobun;
    delete (w as { __electrobun?: unknown }).__electrobun;
    ensureElectrobunGlobal();
    expect(typeof w.__electrobun?.receiveMessageFromBun).toBe("function");
    expect(typeof w.__electrobun?.receiveInternalMessageFromBun).toBe(
      "function",
    );
    expect(w.__electrobun).not.toBe(first);
  });

  it("propagates the install failure when window rejects new properties", () => {
    makeWindow();
    Object.freeze(globalThis.window);
    expect(() => ensureElectrobunGlobal()).toThrow(TypeError);
  });
});
