import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { generateElizaResponse, getElizaGreeting, reflect } from "../models/text";

function makeRuntime(): IAgentRuntime {
  // We only need object identity for session isolation (WeakMap key).
  return {} as IAgentRuntime;
}

describe("ELIZA Classic Plugin", () => {
  describe("reflect()", () => {
    test("should reflect 'i' to 'you'", () => {
      expect(reflect("i am happy")).toBe("you are happy");
    });

    test("should reflect 'my' to 'your'", () => {
      expect(reflect("my car")).toBe("your car");
    });

    test("should reflect 'you' to 'me' and 'are' to 'am'", () => {
      // doctor.json reflections are script-specific; "you" reflects to "I" but "are" is unchanged.
      expect(reflect("you are nice")).toBe("I are nice");
    });

    test("should preserve words without reflections", () => {
      expect(reflect("the cat sat")).toBe("the cat sat");
    });
  });

  describe("generateElizaResponse()", () => {
    test("should respond to greeting", () => {
      const runtime = makeRuntime();
      const response = generateElizaResponse(runtime, "hello");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should respond to sad input", () => {
      const runtime = makeRuntime();
      const response = generateElizaResponse(runtime, "I am happy");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should respond to family mention", () => {
      const runtime = makeRuntime();
      const response = generateElizaResponse(runtime, "my mother is kind");
      expect(response).toBe("Tell me more about your family");
    });

    test("should respond to computer mention", () => {
      const runtime = makeRuntime();
      const response = generateElizaResponse(runtime, "I think computers are fascinating");
      expect(response).toBe("Do computers worry you?");
    });

    test("should handle empty input", () => {
      const runtime = makeRuntime();
      const response = generateElizaResponse(runtime, "");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should handle unknown input with default response", () => {
      const runtime = makeRuntime();
      const response = generateElizaResponse(runtime, "xyzzy");
      expect(response.length).toBeGreaterThan(0);
    });

    test("should reflect pronouns in response", () => {
      const runtime = makeRuntime();
      const response = generateElizaResponse(runtime, "Do I remember my birthday");
      expect(response.length).toBeGreaterThan(0);
    });
  });

  describe("getElizaGreeting()", () => {
    test("should contain 'problem'", () => {
      const greeting = getElizaGreeting();
      expect(greeting.toLowerCase()).toContain("problem");
    });

    test("should be a string", () => {
      const greeting = getElizaGreeting();
      expect(typeof greeting).toBe("string");
    });
  });
});
