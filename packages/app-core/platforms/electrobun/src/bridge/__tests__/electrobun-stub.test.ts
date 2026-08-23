import { afterEach, describe, expect, it } from "vitest";
import { ensureElectrobunGlobal } from "./electrobun-stub.ts";

afterEach(() => {
  // @ts-expect-error cleanup
  delete globalThis.window;
});

function makeWindow() {
  const w = {} as Window & {
    __electrobun?: {
      receiveMessageFromBun: (m: unknown) => void;
      receiveInternalMessageFromBun: (m: unknown) => void;
    };
  };
  (globalThis as { window?: typeof w }).window = w;
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
});
