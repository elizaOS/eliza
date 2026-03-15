/**
 * Unit tests for MiniMax chat completion handlers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleTextSmall,
  handleTextLarge,
  handleObjectSmall,
  handleObjectLarge,
} from "../chat";

// Mock runtime
function createMockRuntime(settings: Record<string, string> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key] || ""),
    character: {
      system: "You are a helpful assistant.",
    },
  } as any;
}

// Mock fetch
const mockFetch = vi.fn();

describe("MiniMax Chat Handlers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("handleTextSmall", () => {
    it("should call MiniMax API with MiniMax-M2.5-highspeed model", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: { content: "Hello from MiniMax!" },
              finish_reason: "stop",
            },
          ],
        }),
      });

      const result = await handleTextSmall(runtime, {
        prompt: "Hello",
      });

      expect(result).toBe("Hello from MiniMax!");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.minimax.io/v1/chat/completions");
      expect(options.headers.Authorization).toBe("Bearer test-api-key");

      const body = JSON.parse(options.body);
      expect(body.model).toBe("MiniMax-M2.5-highspeed");
      expect(body.temperature).toBe(1.0); // Default temperature
    });

    it("should clamp temperature=0 to 0.01", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "response" } }],
        }),
      });

      await handleTextSmall(runtime, {
        prompt: "test",
        temperature: 0,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.01);
    });

    it("should throw when API key is missing", async () => {
      const runtime = createMockRuntime({});
      await expect(
        handleTextSmall(runtime, { prompt: "test" })
      ).rejects.toThrow("MINIMAX_API_KEY is not set");
    });

    it("should throw on API error", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      await expect(
        handleTextSmall(runtime, { prompt: "test" })
      ).rejects.toThrow("MiniMax API request failed (401)");
    });
  });

  describe("handleTextLarge", () => {
    it("should call MiniMax API with MiniMax-M2.5 model", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Large model response" } }],
        }),
      });

      const result = await handleTextLarge(runtime, {
        prompt: "Complex question",
      });

      expect(result).toBe("Large model response");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("MiniMax-M2.5");
    });
  });

  describe("handleObjectSmall", () => {
    it("should parse JSON from response", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '{"name": "test", "value": 42}',
              },
            },
          ],
        }),
      });

      const result = await handleObjectSmall(runtime, {
        prompt: "Generate JSON",
      });

      expect(result).toEqual({ name: "test", value: 42 });
    });

    it("should extract JSON from surrounding text", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  'Here is the JSON:\n{"result": true}\nDone.',
              },
            },
          ],
        }),
      });

      const result = await handleObjectSmall(runtime, {
        prompt: "Generate JSON",
      });

      expect(result).toEqual({ result: true });
    });
  });

  describe("handleObjectLarge", () => {
    it("should use MiniMax-M2.5 model", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok": true}' } }],
        }),
      });

      await handleObjectLarge(runtime, {
        prompt: "Generate JSON",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("MiniMax-M2.5");
    });
  });

  describe("custom base URL", () => {
    it("should use custom base URL when configured", async () => {
      const runtime = createMockRuntime({
        MINIMAX_API_KEY: "test-api-key",
        MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "response" } }],
        }),
      });

      await handleTextSmall(runtime, { prompt: "test" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.minimaxi.com/v1/chat/completions"
      );
    });
  });
});
