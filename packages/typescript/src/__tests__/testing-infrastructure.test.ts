/**
 * @fileoverview Tests for the testing infrastructure
 *
 * These tests verify that our testing utilities work correctly.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createTestCharacter,
  createTestMemory,
  expectRejection,
  generateTestId,
  measureTime,
  retry,
  testDataGenerators,
  waitFor,
} from "../testing/test-helpers";

describe("Testing Infrastructure", () => {
  describe("generateTestId", () => {
    it("should generate valid UUID format", () => {
      const id = generateTestId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it("should generate unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateTestId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("createTestMemory", () => {
    it("should create memory with string content", () => {
      const memory = createTestMemory({ content: "Hello, world!" });

      expect(memory.id).toBeDefined();
      expect(memory.entityId).toBeDefined();
      expect(memory.roomId).toBeDefined();
      expect(memory.content).toEqual({ text: "Hello, world!" });
      expect(memory.createdAt).toBeGreaterThan(0);
    });

    it("should create memory with Content object", () => {
      const content = { text: "Test", actions: ["action1"] };
      const memory = createTestMemory({ content });

      expect(memory.content).toEqual(content);
    });

    it("should use provided IDs", () => {
      const entityId = generateTestId();
      const roomId = generateTestId();
      const agentId = generateTestId();

      const memory = createTestMemory({
        entityId,
        roomId,
        agentId,
        content: "Test",
      });

      expect(memory.entityId).toBe(entityId);
      expect(memory.roomId).toBe(roomId);
      expect(memory.agentId).toBe(agentId);
    });
  });

  describe("createTestCharacter", () => {
    it("should create character with defaults", () => {
      const character = createTestCharacter();

      expect(character.name).toBe("TestAgent");
      expect(character.system).toBe("You are a test agent.");
      expect(character.bio).toEqual(["Test agent"]);
      expect(character.topics).toEqual(["testing"]);
    });

    it("should apply overrides", () => {
      const character = createTestCharacter({
        name: "CustomAgent",
        topics: ["custom", "topics"],
      });

      expect(character.name).toBe("CustomAgent");
      expect(character.topics).toEqual(["custom", "topics"]);
      // Other defaults should still apply
      expect(character.system).toBe("You are a test agent.");
    });
  });

  describe("waitFor", () => {
    it("should resolve immediately when condition is true", async () => {
      let called = false;
      await waitFor(() => {
        called = true;
        return true;
      });
      expect(called).toBe(true);
    });

    it("should wait for condition to become true", async () => {
      let counter = 0;
      await waitFor(
        () => {
          counter++;
          return counter >= 3;
        },
        { interval: 10 },
      );
      expect(counter).toBe(3);
    });

    it("should throw on timeout", async () => {
      await expect(
        waitFor(() => false, { timeout: 50, interval: 10 }),
      ).rejects.toThrow("Condition not met within 50ms timeout");
    });

    it("should work with async conditions", async () => {
      let counter = 0;
      await waitFor(
        async () => {
          counter++;
          await new Promise((r) => setTimeout(r, 5));
          return counter >= 2;
        },
        { interval: 10 },
      );
      expect(counter).toBe(2);
    });
  });

  describe("expectRejection", () => {
    it("should catch rejected promise", async () => {
      const error = await expectRejection(
        Promise.reject(new Error("Test error")),
      );
      expect(error.message).toBe("Test error");
    });

    it("should throw if promise resolves", async () => {
      await expect(expectRejection(Promise.resolve("value"))).rejects.toThrow(
        "Expected promise to reject but it resolved",
      );
    });

    it("should throw if error is not an Error instance", async () => {
      await expect(
        expectRejection(Promise.reject("string error")),
      ).rejects.toThrow("Expected Error but got: string");
    });

    it("should check error message with string", async () => {
      const error = await expectRejection(
        Promise.reject(new Error("Full error message here")),
        "error message",
      );
      expect(error.message).toBe("Full error message here");
    });

    it("should check error message with RegExp", async () => {
      const error = await expectRejection(
        Promise.reject(new Error("Error code: 123")),
        /code: \d+/,
      );
      expect(error.message).toBe("Error code: 123");
    });

    it("should throw if message does not match string", async () => {
      await expect(
        expectRejection(
          Promise.reject(new Error("Actual error")),
          "Expected error",
        ),
      ).rejects.toThrow('include "Expected error"');
    });

    it("should throw if message does not match RegExp", async () => {
      await expect(
        expectRejection(Promise.reject(new Error("Actual error")), /^Expected/),
      ).rejects.toThrow("match /^Expected/");
    });
  });

  describe("retry", () => {
    it("should return result on first success", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await retry(fn);
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should retry on failure", async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Fail");
        }
        return "success";
      });

      const result = await retry(fn, { baseDelay: 1 });
      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should throw after max retries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Always fails"));
      await expect(retry(fn, { maxRetries: 2, baseDelay: 1 })).rejects.toThrow(
        "Always fails",
      );
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("should use exponential backoff", async () => {
      const timestamps: number[] = [];
      const fn = vi.fn().mockImplementation(async () => {
        timestamps.push(Date.now());
        if (timestamps.length < 3) {
          throw new Error("Fail");
        }
        return "success";
      });

      await retry(fn, { baseDelay: 50 });

      // First retry should be ~50ms, second ~100ms
      const firstDelay = timestamps[1] - timestamps[0];
      const secondDelay = timestamps[2] - timestamps[1];
      expect(firstDelay).toBeGreaterThanOrEqual(40);
      expect(secondDelay).toBeGreaterThanOrEqual(80);
    });
  });

  describe("measureTime", () => {
    it("should return result and duration", async () => {
      const { result, durationMs } = await measureTime(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "done";
      });

      expect(result).toBe("done");
      expect(durationMs).toBeGreaterThanOrEqual(40);
      expect(durationMs).toBeLessThan(200);
    });

    it("should propagate errors", async () => {
      await expect(
        measureTime(async () => {
          throw new Error("Test error");
        }),
      ).rejects.toThrow("Test error");
    });
  });

  describe("testDataGenerators", () => {
    describe("uuid", () => {
      it("should generate valid UUID", () => {
        const id = testDataGenerators.uuid();
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      });
    });

    describe("randomString", () => {
      it("should generate string of default length", () => {
        const str = testDataGenerators.randomString();
        expect(str.length).toBe(10);
      });

      it("should generate string of custom length", () => {
        const str = testDataGenerators.randomString(20);
        expect(str.length).toBe(20);
      });

      it("should only contain alphanumeric characters", () => {
        const str = testDataGenerators.randomString(100);
        expect(str).toMatch(/^[a-zA-Z0-9]+$/);
      });
    });

    describe("randomSentence", () => {
      it("should generate sentence with 5-14 words", () => {
        // Run multiple times to account for randomness
        for (let i = 0; i < 10; i++) {
          const sentence = testDataGenerators.randomSentence();
          const wordCount = sentence.split(" ").length;
          expect(wordCount).toBeGreaterThanOrEqual(5);
          expect(wordCount).toBeLessThanOrEqual(14);
        }
      });
    });
  });
});
