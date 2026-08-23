import { describe, expect, it, vi } from "vitest";
import { runRestoredPointerFallback } from "./pointer-fallback.js";

describe("runRestoredPointerFallback", () => {
  it("restores the user's pointer after a bounded coordinate fallback", async () => {
    let cursor = { x: 700, y: 400 };
    const restoreCursor = vi.fn(async (point: { x: number; y: number }) => {
      cursor = { ...point };
    });
    const result = await runRestoredPointerFallback({
      readCursor: async () => ({ ...cursor }),
      restoreCursor,
      expectedPath: [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ],
      operation: async () => {
        cursor = { x: 200, y: 200 };
      },
    });

    expect(result).toEqual({
      restoredTo: { x: 700, y: 400 },
      pointerBorrowed: true,
    });
    expect(restoreCursor).toHaveBeenCalledWith({ x: 700, y: 400 });
    expect(cursor).toEqual({ x: 700, y: 400 });
  });

  it("fails closed and preserves the user's new pointer location on interference", async () => {
    let cursor = { x: 700, y: 400 };
    const restoreCursor = vi.fn(async (point: { x: number; y: number }) => {
      cursor = { ...point };
    });

    await expect(
      runRestoredPointerFallback({
        readCursor: async () => ({ ...cursor }),
        restoreCursor,
        expectedPath: [{ x: 200, y: 200 }],
        operation: async () => {
          cursor = { x: 1200, y: 800 };
        },
      }),
    ).rejects.toThrow("USER_INPUT_INTERFERENCE");
    expect(restoreCursor).not.toHaveBeenCalled();
    expect(cursor).toEqual({ x: 1200, y: 800 });
  });
});
