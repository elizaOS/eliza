import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotProxyClient, CopilotProxyError } from "../src/client";
import {
  AVAILABLE_MODELS,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_LARGE_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SMALL_MODEL,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeBaseUrl,
} from "../src/environment";
import copilotProxyPlugin from "../src/index";
import { CopilotProxyService, getCopilotProxyService } from "../src/service";
import {
  assertValidBaseUrl,
  createModelName,
  createValidatedBaseUrl,
  isReconstructedResponse,
  isUnstructuredResponse,
} from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRuntime(
  overrides: Record<string, string> = {},
): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => overrides[key] ?? undefined),
    character: { system: "You are a helpful assistant." },
    agentId: "test-agent",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

// ---------------------------------------------------------------------------
// Plugin metadata tests
// ---------------------------------------------------------------------------

describe("Copilot Proxy plugin metadata", () => {
  it("exports correct plugin name", () => {
    expect(copilotProxyPlugin.name).toBe("copilot-proxy");
  });

  it("exports description containing Copilot Proxy", () => {
    expect(copilotProxyPlugin.description).toContain("Copilot Proxy");
  });

  it("has model handlers for all 4 model types", () => {
    expect(copilotProxyPlugin.models).toBeDefined();
    const models = copilotProxyPlugin.models!;
    expect(models[ModelType.TEXT_SMALL]).toBeDefined();
    expect(models[ModelType.TEXT_LARGE]).toBeDefined();
    expect(models[ModelType.OBJECT_SMALL]).toBeDefined();
    expect(models[ModelType.OBJECT_LARGE]).toBeDefined();
  });

  it("has test suites defined", () => {
    expect(Array.isArray(copilotProxyPlugin.tests)).toBe(true);
    expect(copilotProxyPlugin.tests!.length).toBeGreaterThan(0);
  });

  it("has config keys defined", () => {
    const config = copilotProxyPlugin.config!;
    expect("COPILOT_PROXY_BASE_URL" in config).toBe(true);
    expect("COPILOT_PROXY_ENABLED" in config).toBe(true);
    expect("COPILOT_PROXY_SMALL_MODEL" in config).toBe(true);
    expect("COPILOT_PROXY_LARGE_MODEL" in config).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Environment / config helpers
// ---------------------------------------------------------------------------

describe("normalizeBaseUrl", () => {
  it("appends /v1 when missing", () => {
    expect(normalizeBaseUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/v1",
    );
  });

  it("strips trailing slash before appending /v1", () => {
    expect(normalizeBaseUrl("http://localhost:3000/")).toBe(
      "http://localhost:3000/v1",
    );
  });

  it("keeps /v1 if already present", () => {
    expect(normalizeBaseUrl("http://localhost:3000/v1")).toBe(
      "http://localhost:3000/v1",
    );
  });

  it("returns default for empty string", () => {
    expect(normalizeBaseUrl("")).toBe(DEFAULT_BASE_URL);
  });
});

// ---------------------------------------------------------------------------
// Type utilities
// ---------------------------------------------------------------------------

describe("type utilities", () => {
  it("createModelName throws for empty string", () => {
    expect(() => createModelName("")).toThrow();
  });

  it("createModelName succeeds for valid name", () => {
    const name = createModelName("gpt-5-mini");
    expect(name).toBe("gpt-5-mini");
  });

  it("createValidatedBaseUrl succeeds for valid URL", () => {
    const url = createValidatedBaseUrl("http://localhost:3000/v1");
    expect(url).toBe("http://localhost:3000/v1");
  });

  it("assertValidBaseUrl throws for empty URL", () => {
    expect(() => assertValidBaseUrl("")).toThrow();
    expect(() => assertValidBaseUrl(undefined)).toThrow();
  });

  it("isReconstructedResponse identifies correct type", () => {
    expect(isReconstructedResponse({ type: "reconstructed_response" })).toBe(
      true,
    );
    expect(isReconstructedResponse({ type: "other" })).toBe(false);
  });

  it("isUnstructuredResponse identifies correct type", () => {
    expect(
      isUnstructuredResponse({ type: "unstructured_response", content: "x" }),
    ).toBe(true);
    expect(isUnstructuredResponse({ foo: "bar" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CopilotProxyClient
// ---------------------------------------------------------------------------

describe("CopilotProxyClient", () => {
  it("constructs with base URL and timeout", () => {
    const client = new CopilotProxyClient("http://localhost:3000/v1", 60, 4096);
    expect(client.completionsUrl).toBe(
      "http://localhost:3000/v1/chat/completions",
    );
  });

  it("strips trailing slash from base URL", () => {
    const client = new CopilotProxyClient(
      "http://localhost:3000/v1/",
      60,
      4096,
    );
    expect(client.completionsUrl).toBe(
      "http://localhost:3000/v1/chat/completions",
    );
  });

  it("healthCheck returns false for unreachable server", async () => {
    const client = new CopilotProxyClient("http://127.0.0.1:1/v1", 1, 4096);
    const result = await client.healthCheck();
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CopilotProxyError
// ---------------------------------------------------------------------------

describe("CopilotProxyError", () => {
  it("contains status code and response body", () => {
    const err = new CopilotProxyError("test error", 404, "not found");
    expect(err.statusCode).toBe(404);
    expect(err.responseBody).toBe("not found");
    expect(err.name).toBe("CopilotProxyError");
    expect(err.message).toBe("test error");
  });
});

// ---------------------------------------------------------------------------
// CopilotProxyService
// ---------------------------------------------------------------------------

describe("CopilotProxyService", () => {
  it("starts uninitialized and unavailable", () => {
    const service = new CopilotProxyService();
    expect(service.isAvailable).toBe(false);
    expect(service.getClient()).toBeNull();
  });

  it("getSmallModel throws before initialization", () => {
    const service = new CopilotProxyService();
    expect(() => service.getSmallModel()).toThrow("not initialized");
  });

  it("getLargeModel throws before initialization", () => {
    const service = new CopilotProxyService();
    expect(() => service.getLargeModel()).toThrow("not initialized");
  });

  it("getContextWindow returns default before init", () => {
    const service = new CopilotProxyService();
    expect(service.getContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("getMaxTokens returns default before init", () => {
    const service = new CopilotProxyService();
    expect(service.getMaxTokens()).toBe(DEFAULT_MAX_TOKENS);
  });

  it("generateTextSmall throws before initialization", async () => {
    const service = new CopilotProxyService();
    await expect(service.generateTextSmall("hello")).rejects.toThrow(
      "not initialized",
    );
  });

  it("shutdown resets state", async () => {
    const service = new CopilotProxyService();
    await service.shutdown();
    expect(service.isAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AVAILABLE_MODELS
// ---------------------------------------------------------------------------

describe("AVAILABLE_MODELS", () => {
  it("contains expected default models", () => {
    expect(AVAILABLE_MODELS).toContain(DEFAULT_SMALL_MODEL);
    expect(AVAILABLE_MODELS).toContain(DEFAULT_LARGE_MODEL);
  });

  it("has at least 10 models", () => {
    expect(AVAILABLE_MODELS.length).toBeGreaterThanOrEqual(10);
  });
});
