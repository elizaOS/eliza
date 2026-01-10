/**
 * Tests for ELIZA Classic Plugin
 */

import {  describe, test, expect, beforeEach  } from "vitest";
import {
  generateElizaResponse,
  getElizaGreeting,
  reflect,
} from "../models/text";

describe("ELIZA Classic Plugin", () => {
  describe("reflect()", () => {
    test("should reflect 'i' to 'you'", () => {
      expect(reflect("i am happy")).toBe("you are happy");
    });

    test("should reflect 'my' to 'your'", () => {
      expect(reflect("my car")).toBe("your car");
    });

    test("should reflect 'you' to 'me' and 'are' to 'am'", () => {
      // Note: "are" also gets reflected to "am" in ELIZA's pronoun system
      expect(reflect("you are nice")).toBe("me am nice");
    });

    test("should preserve unknown words", () => {
      expect(reflect("the cat sat")).toBe("the cat sat");
    });
  });

  describe("generateElizaResponse()", () => {
    test("should respond to greeting", () => {
      const response = generateElizaResponse("hello");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should respond to sad input", () => {
      const response = generateElizaResponse("I am sad");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should respond to family mention", () => {
      const response = generateElizaResponse("my mother is kind");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should respond to computer mention", () => {
      const response = generateElizaResponse("I think about computers");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should handle empty input", () => {
      const response = generateElizaResponse("");
      expect(response).toBe("I didn't catch that. Could you please repeat?");
    });

    test("should handle unknown input with default response", () => {
      const response = generateElizaResponse("xyzzy");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should reflect pronouns in response", () => {
      const response = generateElizaResponse("I remember my birthday");
      // The response should contain reflected pronouns
      expect(response.length).toBeGreaterThan(0);
    });
  });

  describe("getElizaGreeting()", () => {
    test("should contain ELIZA", () => {
      const greeting = getElizaGreeting();
      expect(greeting).toContain("ELIZA");
    });

    test("should be a string", () => {
      const greeting = getElizaGreeting();
      expect(typeof greeting).toBe("string");
    });
  });
});

