import { describe, expect, test, vi, beforeEach } from "vitest";
import { runAutonomyPostResponse, fieldsToContent } from "./execution-facade";

describe("execution-facade", () => {
  describe("fieldsToContent", () => {
    test("converts flat fields object to content structure", () => {
      const fields = {
        text: "Hello world",
        action: "CONTINUE",
      };

      const result = fieldsToContent(fields);

      expect(result).toEqual({
        text: "Hello world",
        action: "CONTINUE",
      });
    });

    test("handles empty fields object", () => {
      const result = fieldsToContent({});
      expect(result).toEqual({});
    });

    test("handles undefined and null values", () => {
      const fields = {
        text: "Hello",
        empty: null,
        missing: undefined,
      };

      const result = fieldsToContent(fields);

      expect(result.text).toBe("Hello");
      expect(result.empty).toBeNull();
      expect(result.missing).toBeUndefined();
    });

    test("preserves nested objects", () => {
      const fields = {
        text: "Hello",
        metadata: { key: "value" },
      };

      const result = fieldsToContent(fields);

      expect(result.metadata).toEqual({ key: "value" });
    });
  });

  describe("runAutonomyPostResponse", () => {
    let mockRuntime: any;
    let mockMemory: any;

    beforeEach(() => {
      mockMemory = {
        id: "test-memory-id",
        roomId: "test-room-id",
        entityId: "test-entity-id",
        content: { text: "test message" },
      };

      mockRuntime = {
        agentId: "test-agent-id",
        emitEvent: vi.fn().mockResolvedValue(undefined),
        logger: {
          info: vi.fn(),
          debug: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      };
    });

    test("handles response with actions", async () => {
      const response = {
        didRespond: true,
        mode: "autonomy",
        responseContent: {
          text: "Response text",
          actions: ["CONTINUE"],
        },
      };

      await runAutonomyPostResponse(mockRuntime, mockMemory, response);

      // Should not throw
      expect(mockRuntime.logger.error).not.toHaveBeenCalled();
    });

    test("handles response without actions gracefully", async () => {
      const response = {
        didRespond: true,
        mode: "autonomy",
        responseContent: {
          text: "Response text",
        },
      };

      await runAutonomyPostResponse(mockRuntime, mockMemory, response);

      expect(mockRuntime.logger.error).not.toHaveBeenCalled();
    });

    test("handles null response gracefully", async () => {
      await runAutonomyPostResponse(mockRuntime, mockMemory, null);

      // Should not throw
    });

    test("handles undefined responseContent", async () => {
      const response = {
        didRespond: false,
        mode: "autonomy",
        responseContent: undefined,
      };

      await runAutonomyPostResponse(mockRuntime, mockMemory, response);

      expect(mockRuntime.logger.error).not.toHaveBeenCalled();
    });
  });
});
