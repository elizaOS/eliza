import { describe, expect, it } from "vitest";
import { moltbookFailure, moltbookSuccess } from "../src/types";

describe("MoltbookResult helpers", () => {
  describe("moltbookSuccess", () => {
    it("creates a success result with data", () => {
      const data = { id: "test-123", name: "Test Post" };
      const result = moltbookSuccess(data);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(data);
    });

    it("creates a success result with array data", () => {
      const data = [
        { id: "1", title: "Post 1" },
        { id: "2", title: "Post 2" },
      ];
      const result = moltbookSuccess(data);

      expect(result.success).toBe(true);
      expect(result.data).toEqual(data);
      expect(result.data).toHaveLength(2);
    });

    it("creates a success result with null data", () => {
      const result = moltbookSuccess(null);

      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });

    it("creates a success result with empty array", () => {
      const result = moltbookSuccess([]);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe("moltbookFailure", () => {
    it("creates a failure result with error message", () => {
      const error = "API request failed";
      const result = moltbookFailure<string>(error);

      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
      expect(result.data).toBeUndefined();
    });

    it("preserves detailed error messages", () => {
      const error = "API returned 404: Submolt 'test' not found";
      const result = moltbookFailure<object>(error);

      expect(result.success).toBe(false);
      expect(result.error).toBe(error);
    });
  });

  describe("type discrimination", () => {
    it("allows type narrowing based on success", () => {
      const successResult = moltbookSuccess({ value: 42 });
      const failureResult = moltbookFailure<{ value: number }>("error");

      // Type narrowing should work
      if (successResult.success) {
        // TypeScript should know data exists here
        expect(successResult.data.value).toBe(42);
      }

      if (!failureResult.success) {
        // TypeScript should know error exists here
        expect(failureResult.error).toBe("error");
      }
    });
  });
});
