/**
 * Behavior coverage for shared-runtime error types.
 *
 * These classes are deliberately dependency-free: coordinator and route
 * boundaries need real class identity for these errors without dragging the
 * billing/runtime module graph into their own graphs. Several catch sites
 * additionally match on `error.name` because the class cannot survive the
 * Durable Object fetch boundary — so name identity is part of the contract.
 */
import { describe, expect, test } from "bun:test";
import { SharedRuntimeCacheWarmingError, SharedTurnConflictError } from "./shared-runtime-errors";

describe("SharedRuntimeCacheWarmingError", () => {
  test("is an Error with the stable class name", () => {
    const error = new SharedRuntimeCacheWarmingError("warming failed");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SharedRuntimeCacheWarmingError);
    expect(error.name).toBe("SharedRuntimeCacheWarmingError");
  });

  test("carries the message through", () => {
    const error = new SharedRuntimeCacheWarmingError("cache warm aborted");
    expect(error.message).toBe("cache warm aborted");
  });
});

describe("SharedTurnConflictError", () => {
  test("is an Error with the stable class name", () => {
    const error = new SharedTurnConflictError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SharedTurnConflictError);
    expect(error.name).toBe("SharedTurnConflictError");
  });

  test("defaults to the clientMessageId-reuse message", () => {
    const error = new SharedTurnConflictError();
    expect(error.message).toBe("clientMessageId was already used with a different message.");
  });

  test("accepts a custom message", () => {
    const error = new SharedTurnConflictError("duplicate id");
    expect(error.message).toBe("duplicate id");
  });
});
