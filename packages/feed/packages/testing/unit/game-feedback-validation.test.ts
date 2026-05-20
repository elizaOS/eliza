/**
 * Comprehensive unit tests for Game Feedback validation schema
 *
 * Tests the shared Zod schema used in /api/feedback/game-feedback
 * Covers boundary conditions, invalid inputs, and edge cases
 */

import { describe, expect, test } from "bun:test";
import { GameFeedbackSchema } from "@feed/shared";

describe("Game Feedback Validation Schema", () => {
  // ============================================
  // VALID INPUTS
  // ============================================
  describe("Valid Inputs", () => {
    test("valid bug report with all fields", () => {
      const input = {
        feedbackType: "bug",
        description: "This is a valid bug description",
        stepsToReproduce: "1. Do this\n2. See that",
        screenshotUrl: "https://test.public.blob.vercel-storage.com/image.png",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("valid bug report without screenshot", () => {
      const input = {
        feedbackType: "bug",
        description: "This is a valid bug description",
        stepsToReproduce: "1. Do this",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("valid feature request with rating", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Please add dark mode support",
        rating: 5,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("valid performance issue (minimal fields)", () => {
      const input = {
        feedbackType: "performance",
        description: "The page loads very slowly",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("screenshot URL can be empty string", () => {
      const input = {
        feedbackType: "bug",
        description: "This is a valid bug description",
        stepsToReproduce: "Steps here",
        screenshotUrl: "",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  // ============================================
  // DESCRIPTION BOUNDARY CONDITIONS
  // ============================================
  describe("Description Boundaries", () => {
    test("description exactly 10 chars is valid", () => {
      const input = {
        feedbackType: "performance",
        description: "A".repeat(10),
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("description 9 chars is invalid", () => {
      const input = {
        feedbackType: "performance",
        description: "A".repeat(9),
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Description must be at least 10 characters",
        );
      }
    });

    test("description exactly 5000 chars is valid", () => {
      const input = {
        feedbackType: "performance",
        description: "A".repeat(5000),
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("description 5001 chars is invalid", () => {
      const input = {
        feedbackType: "performance",
        description: "A".repeat(5001),
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("empty description is invalid", () => {
      const input = {
        feedbackType: "performance",
        description: "",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("whitespace-only description is trimmed and rejected", () => {
      const input = {
        feedbackType: "performance",
        description: " ".repeat(10),
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false); // Schema trims whitespace, so 10 spaces becomes empty
    });
  });

  // ============================================
  // STEPS TO REPRODUCE BOUNDARIES
  // ============================================
  describe("Steps to Reproduce Boundaries", () => {
    test("steps exactly 2000 chars is valid", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description here",
        stepsToReproduce: "S".repeat(2000),
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("steps 2001 chars is invalid", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description here",
        stepsToReproduce: "S".repeat(2001),
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("steps required for bug type", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description here",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toContain("stepsToReproduce");
      }
    });

    test("steps NOT required for performance type", () => {
      const input = {
        feedbackType: "performance",
        description: "Valid performance description",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("steps NOT required for feature_request type", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request description",
        rating: 3,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("empty string steps is treated as falsy for bug requirement", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description here",
        stepsToReproduce: "",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false); // Empty string is falsy
    });
  });

  // ============================================
  // RATING BOUNDARIES
  // ============================================
  describe("Rating Boundaries", () => {
    test("rating 1 is valid", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request",
        rating: 1,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("rating 5 is valid", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request",
        rating: 5,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("rating 0 is invalid", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request",
        rating: 0,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rating 6 is invalid", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request",
        rating: 6,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("rating required for feature_request type", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toContain("rating");
      }
    });

    test("rating NOT required for bug type", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description",
        stepsToReproduce: "Steps here",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("rating NOT required for performance type", () => {
      const input = {
        feedbackType: "performance",
        description: "Valid performance description",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("rating must be integer", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request",
        rating: 3.5,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("negative rating is invalid", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid feature request",
        rating: -1,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  // ============================================
  // SCREENSHOT URL VALIDATION
  // ============================================
  describe("Screenshot URL Validation", () => {
    test("valid https URL from allowed domain", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description",
        stepsToReproduce: "Steps",
        screenshotUrl: "https://test.public.blob.vercel-storage.com/image.png",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("valid http URL from allowed domain (local dev)", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description",
        stepsToReproduce: "Steps",
        screenshotUrl: "http://localhost:9000/screenshot.jpg",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("invalid URL is rejected", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description",
        stepsToReproduce: "Steps",
        screenshotUrl: "not-a-valid-url",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("empty string is valid (special case)", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description",
        stepsToReproduce: "Steps",
        screenshotUrl: "",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("undefined is valid (optional)", () => {
      const input = {
        feedbackType: "bug",
        description: "Valid bug description",
        stepsToReproduce: "Steps",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  // ============================================
  // FEEDBACK TYPE VALIDATION
  // ============================================
  describe("Feedback Type Validation", () => {
    test("all valid types are accepted", () => {
      const types = ["bug", "feature_request", "performance"];
      for (const type of types) {
        const input = {
          feedbackType: type,
          description: "Valid description here",
          stepsToReproduce: type === "bug" ? "Steps" : undefined,
          rating: type === "feature_request" ? 3 : undefined,
        };
        const result = GameFeedbackSchema.safeParse(input);
        expect(result.success).toBe(true);
      }
    });

    test("invalid type is rejected", () => {
      const input = {
        feedbackType: "invalid_type",
        description: "Valid description here",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("empty type is rejected", () => {
      const input = {
        feedbackType: "",
        description: "Valid description here",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("undefined type is rejected", () => {
      const input = {
        description: "Valid description here",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  // ============================================
  // TYPE COERCION AND EDGE CASES
  // ============================================
  describe("Type Coercion and Edge Cases", () => {
    test("null values are rejected", () => {
      const input = {
        feedbackType: "performance",
        description: null,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("undefined description is rejected", () => {
      const input = {
        feedbackType: "performance",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("number description is rejected", () => {
      const input = {
        feedbackType: "performance",
        description: 12345678901,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("array description is rejected", () => {
      const input = {
        feedbackType: "performance",
        description: ["array", "of", "strings"],
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("string rating is rejected", () => {
      const input = {
        feedbackType: "feature_request",
        description: "Valid description here",
        rating: "5",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    test("extra fields are stripped", () => {
      const input = {
        feedbackType: "performance",
        description: "Valid description here",
        extraField: "should be ignored",
        anotherExtra: 123,
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(
          (result.data as Record<string, unknown>).extraField,
        ).toBeUndefined();
      }
    });
  });

  // ============================================
  // SPECIAL CHARACTERS
  // ============================================
  describe("Special Characters in Input", () => {
    test("unicode in description is accepted", () => {
      const input = {
        feedbackType: "performance",
        description: "日本語テスト emoji 🎮 ñ é ü",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("HTML in description is accepted (not sanitized at schema level)", () => {
      const input = {
        feedbackType: "performance",
        description: '<script>alert("xss")</script> test',
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("SQL injection in description is accepted (not sanitized at schema level)", () => {
      const input = {
        feedbackType: "performance",
        description: "'; DROP TABLE users; --",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    test("newlines and tabs in description are accepted", () => {
      const input = {
        feedbackType: "performance",
        description: "Line 1\nLine 2\tTabbed",
      };
      const result = GameFeedbackSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });
});
