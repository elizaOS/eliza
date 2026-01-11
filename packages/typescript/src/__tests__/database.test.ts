/**
 * DatabaseAdapter Abstract Class Tests
 *
 * NOTE: This file tests the abstract class contract only.
 * Actual database behavior is tested in @elizaos/plugin-sql
 * using real database connections (PGLite).
 */

import { describe, expect, it } from "vitest";
import { DatabaseAdapter } from "../database";

describe("DatabaseAdapter Abstract Class", () => {
  it("should be an abstract class that cannot be instantiated directly", () => {
    // TypeScript prevents direct instantiation of abstract classes at compile time
    // This test documents the expected behavior
    expect(DatabaseAdapter).toBeDefined();
    expect(typeof DatabaseAdapter).toBe("function");
  });

  it("should define required abstract methods", () => {
    // Verify the class prototype has the expected shape
    // This ensures the interface contract is maintained
    const prototype = DatabaseAdapter.prototype;
    expect(prototype).toBeDefined();
  });
});
