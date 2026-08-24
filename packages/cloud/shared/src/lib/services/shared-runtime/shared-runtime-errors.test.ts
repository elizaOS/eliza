import { describe, expect, it } from "vitest";
import {
  SharedRuntimeCacheWarmingError,
  SharedTurnConflictError,
} from "./shared-runtime-errors.js";

describe("shared-runtime-errors", () => {
  it("SharedRuntimeCacheWarmingError has name and message", () => {
    const e = new SharedRuntimeCacheWarmingError("warming");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SharedRuntimeCacheWarmingError");
    expect(e.message).toBe("warming");
  });

  it("SharedTurnConflictError has default message", () => {
    const e = new SharedTurnConflictError();
    expect(e.name).toBe("SharedTurnConflictError");
    expect(e.message).toMatch(/clientMessageId/);
  });

  it("SharedTurnConflictError uses custom message", () => {
    const e = new SharedTurnConflictError("custom");
    expect(e.message).toBe("custom");
  });
});
