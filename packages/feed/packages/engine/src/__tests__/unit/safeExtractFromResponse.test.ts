/**
 * Tests for safeExtractFromResponse helper
 *
 * This function guards against LLM returning raw strings instead of expected
 * XML-parsed object structures.
 */

import { describe, expect, it } from "bun:test";
import { safeExtractFromResponse } from "../../services/post-generation-helpers";

describe("safeExtractFromResponse", () => {
  describe("Raw string responses", () => {
    it("should return raw string directly", () => {
      const result = safeExtractFromResponse<string>(
        "This is raw text from LLM",
        "content",
      );
      expect(result).toBe("This is raw text from LLM");
    });

    it("should return empty string when provided", () => {
      const result = safeExtractFromResponse<string>("", "content");
      expect(result).toBe("");
    });
  });

  describe("Null and undefined handling", () => {
    it("should return null for null input", () => {
      const result = safeExtractFromResponse<string>(null, "content");
      expect(result).toBeNull();
    });

    it("should return null for undefined input", () => {
      const result = safeExtractFromResponse<string>(undefined, "content");
      expect(result).toBeNull();
    });
  });

  describe("Direct field access", () => {
    it("should extract field directly from object", () => {
      const response = { content: "Hello world", other: "ignored" };
      const result = safeExtractFromResponse<string>(response, "content");
      expect(result).toBe("Hello world");
    });

    it("should return null for missing field", () => {
      const response = { other: "data" };
      const result = safeExtractFromResponse<string>(response, "content");
      expect(result).toBeNull();
    });

    it("should handle nested objects", () => {
      const response = { content: { nested: "value" } };
      const result = safeExtractFromResponse<{ nested: string }>(
        response,
        "content",
      );
      expect(result).toEqual({ nested: "value" });
    });
  });

  describe("Wrapped response structure", () => {
    it("should extract from response.response.field pattern", () => {
      const response = {
        response: {
          content: "Extracted content",
        },
      };
      const result = safeExtractFromResponse<string>(response, "content");
      expect(result).toBe("Extracted content");
    });

    it("should handle deeply nested response", () => {
      const response = {
        response: {
          article: {
            title: "Test Article",
            body: "Article body text",
          },
        },
      };
      const result = safeExtractFromResponse<{ title: string; body: string }>(
        response,
        "article",
      );
      expect(result).toEqual({
        title: "Test Article",
        body: "Article body text",
      });
    });

    it("should return null if field not in wrapped response", () => {
      const response = {
        response: {
          otherField: "data",
        },
      };
      const result = safeExtractFromResponse<string>(response, "content");
      expect(result).toBeNull();
    });
  });

  describe("Edge cases", () => {
    it("should handle arrays", () => {
      const response = { items: ["a", "b", "c"] };
      const result = safeExtractFromResponse<string[]>(response, "items");
      expect(result).toEqual(["a", "b", "c"]);
    });

    it("should handle numbers", () => {
      const response = { count: 42 };
      const result = safeExtractFromResponse<number>(response, "count");
      expect(result).toBe(42);
    });

    it("should handle boolean values", () => {
      const response = { success: true };
      const result = safeExtractFromResponse<boolean>(response, "success");
      expect(result).toBe(true);
    });

    it("should handle false boolean", () => {
      const response = { success: false };
      const result = safeExtractFromResponse<boolean>(response, "success");
      expect(result).toBe(false);
    });

    it("should handle zero", () => {
      const response = { count: 0 };
      const result = safeExtractFromResponse<number>(response, "count");
      expect(result).toBe(0);
    });

    it("should handle non-object primitives", () => {
      const result = safeExtractFromResponse<string>(42, "content");
      expect(result).toBeNull();
    });

    it("should prefer wrapped response over direct field", () => {
      const response = {
        content: "direct value",
        response: {
          content: "wrapped value",
        },
      };
      // The function checks wrapped response.response.field first
      const result = safeExtractFromResponse<string>(response, "content");
      expect(result).toBe("wrapped value");
    });
  });
});
