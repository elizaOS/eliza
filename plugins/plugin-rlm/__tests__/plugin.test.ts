/**
 * Unit tests for the RLM plugin.
 */

import { describe, expect, it } from "vitest";

describe("RLM Plugin", () => {
  describe("Plugin Definition", () => {
    it("should have correct plugin name", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.name).toBe("rlm");
    });

    it("should have plugin description", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.description).toBeDefined();
      expect(rlmPlugin.description.length).toBeGreaterThan(0);
      expect(rlmPlugin.description).toContain("RLM");
    });

    it("should have models registered", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.models).toBeDefined();
      expect(Object.keys(rlmPlugin.models ?? {}).length).toBeGreaterThan(0);
    });

    it("should have test suites defined", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.tests).toBeDefined();
      expect(rlmPlugin.tests?.length).toBeGreaterThan(0);
    });
  });

  describe("Config", () => {
    it("should have config options defined", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.config).toBeDefined();
    });

    it("should have all expected config keys", async () => {
      const { rlmPlugin, ENV_VARS } = await import("../index");
      const config = rlmPlugin.config;
      expect(config).toHaveProperty(ENV_VARS.BACKEND);
      expect(config).toHaveProperty(ENV_VARS.ENVIRONMENT);
      expect(config).toHaveProperty(ENV_VARS.MAX_ITERATIONS);
      expect(config).toHaveProperty(ENV_VARS.MAX_DEPTH);
      expect(config).toHaveProperty(ENV_VARS.VERBOSE);
      expect(config).toHaveProperty(ENV_VARS.PYTHON_PATH);
    });
  });

  describe("Model Handlers", () => {
    it("should have TEXT_SMALL model handler", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.models?.TEXT_SMALL).toBeDefined();
      expect(typeof rlmPlugin.models?.TEXT_SMALL).toBe("function");
    });

    it("should have TEXT_LARGE model handler", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.models?.TEXT_LARGE).toBeDefined();
      expect(typeof rlmPlugin.models?.TEXT_LARGE).toBe("function");
    });

    it("should have REASONING_SMALL model handler", async () => {
      const { rlmPlugin } = await import("../index");
      // ModelType.TEXT_REASONING_SMALL has value "REASONING_SMALL"
      expect(rlmPlugin.models?.REASONING_SMALL).toBeDefined();
      expect(typeof rlmPlugin.models?.REASONING_SMALL).toBe("function");
    });

    it("should have REASONING_LARGE model handler", async () => {
      const { rlmPlugin } = await import("../index");
      // ModelType.TEXT_REASONING_LARGE has value "REASONING_LARGE"
      expect(rlmPlugin.models?.REASONING_LARGE).toBeDefined();
      expect(typeof rlmPlugin.models?.REASONING_LARGE).toBe("function");
    });

    it("should have TEXT_COMPLETION model handler", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.models?.TEXT_COMPLETION).toBeDefined();
      expect(typeof rlmPlugin.models?.TEXT_COMPLETION).toBe("function");
    });
  });

  describe("Init Function", () => {
    it("should have an init function", async () => {
      const { rlmPlugin } = await import("../index");
      expect(rlmPlugin.init).toBeDefined();
      expect(typeof rlmPlugin.init).toBe("function");
    });
  });
});

describe("RLM Types", () => {
  describe("DEFAULT_CONFIG", () => {
    it("should have expected default values", async () => {
      const { DEFAULT_CONFIG } = await import("../types");
      expect(DEFAULT_CONFIG.backend).toBe("gemini");
      expect(DEFAULT_CONFIG.environment).toBe("local");
      expect(DEFAULT_CONFIG.maxIterations).toBe(4);
      expect(DEFAULT_CONFIG.maxDepth).toBe(1);
      expect(DEFAULT_CONFIG.verbose).toBe(false);
      expect(DEFAULT_CONFIG.pythonPath).toBe("python");
    });

    it("should have retry configuration defaults", async () => {
      const { DEFAULT_CONFIG } = await import("../types");
      expect(DEFAULT_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_CONFIG.retryBaseDelay).toBe(1000);
      expect(DEFAULT_CONFIG.retryMaxDelay).toBe(30000);
    });
  });

  describe("ENV_VARS", () => {
    it("should have all environment variable names", async () => {
      const { ENV_VARS } = await import("../types");
      expect(ENV_VARS.BACKEND).toBe("ELIZA_RLM_BACKEND");
      expect(ENV_VARS.ENVIRONMENT).toBe("ELIZA_RLM_ENV");
      expect(ENV_VARS.MAX_ITERATIONS).toBe("ELIZA_RLM_MAX_ITERATIONS");
      expect(ENV_VARS.MAX_DEPTH).toBe("ELIZA_RLM_MAX_DEPTH");
      expect(ENV_VARS.VERBOSE).toBe("ELIZA_RLM_VERBOSE");
      expect(ENV_VARS.PYTHON_PATH).toBe("ELIZA_RLM_PYTHON_PATH");
    });
  });
});

describe("RLM Client", () => {
  describe("configFromEnv", () => {
    it("should return default config with empty env", async () => {
      const { configFromEnv, DEFAULT_CONFIG } = await import("../client");
      const config = configFromEnv({});
      expect(config.backend).toBe(DEFAULT_CONFIG.backend);
      expect(config.environment).toBe(DEFAULT_CONFIG.environment);
      expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
      expect(config.maxDepth).toBe(DEFAULT_CONFIG.maxDepth);
      expect(config.verbose).toBe(DEFAULT_CONFIG.verbose);
      expect(config.pythonPath).toBe(DEFAULT_CONFIG.pythonPath);
    });

    it("should read config from env vars", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({
        ELIZA_RLM_BACKEND: "openai",
        ELIZA_RLM_ENV: "docker",
        ELIZA_RLM_MAX_ITERATIONS: "8",
        ELIZA_RLM_MAX_DEPTH: "2",
        ELIZA_RLM_VERBOSE: "true",
        ELIZA_RLM_PYTHON_PATH: "/usr/bin/python3",
      });
      expect(config.backend).toBe("openai");
      expect(config.environment).toBe("docker");
      expect(config.maxIterations).toBe(8);
      expect(config.maxDepth).toBe(2);
      expect(config.verbose).toBe(true);
      expect(config.pythonPath).toBe("/usr/bin/python3");
    });
  });

  describe("RLMClient.normalizeMessages", () => {
    it("should convert string to message array", async () => {
      const { RLMClient } = await import("../client");
      const messages = RLMClient.normalizeMessages("Hello, world!");
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello, world!");
    });

    it("should pass through message array", async () => {
      const { RLMClient } = await import("../client");
      const input = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there" },
      ];
      const messages = RLMClient.normalizeMessages(input);
      expect(messages).toEqual(input);
    });
  });

  describe("stubResult", () => {
    it("should return stub result", async () => {
      const { stubResult } = await import("../client");
      const result = stubResult();
      expect(result.metadata.stub).toBe(true);
      expect(result.text).toContain("[RLM STUB]");
    });

    it("should include error in stub result", async () => {
      const { stubResult } = await import("../client");
      const result = stubResult("Test error");
      expect(result.metadata.stub).toBe(true);
      expect(result.metadata.error).toBe("Test error");
    });
  });

  describe("RLMClient Metrics", () => {
    it("should initialize with zero metrics", async () => {
      const { RLMClient } = await import("../client");
      const client = new RLMClient({ pythonPath: "/nonexistent/python" });
      const metrics = client.getMetrics();

      expect(metrics.totalRequests).toBe(0);
      expect(metrics.successfulRequests).toBe(0);
      expect(metrics.failedRequests).toBe(0);
      expect(metrics.stubResponses).toBe(0);
      expect(metrics.totalRetries).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
    });

    it("should allow registering metrics callback", async () => {
      const { RLMClient } = await import("../client");
      const client = new RLMClient({ pythonPath: "/nonexistent/python" });

      let callbackCalled = false;
      client.onMetrics((metrics) => {
        callbackCalled = true;
        expect(metrics.totalRequests).toBeGreaterThan(0);
      });

      // Trigger a request (will fail/stub)
      await client.infer("test");

      expect(callbackCalled).toBe(true);
    });

    it("should track stub responses in metrics", async () => {
      const { RLMClient } = await import("../client");
      const client = new RLMClient({ pythonPath: "/nonexistent/python" });

      await client.infer("test1");
      await client.infer("test2");

      const metrics = client.getMetrics();
      expect(metrics.totalRequests).toBe(2);
      expect(metrics.stubResponses).toBe(2);
    });
  });
});

// ============================================================================
// COMPREHENSIVE TEST EXPANSION - Boundary, Edge Cases, Error Handling
// ============================================================================

describe("Boundary Conditions", () => {
  describe("Config Boundary Values", () => {
    it("should handle maxIterations of 1 (minimum)", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_MAX_ITERATIONS: "1" });
      expect(config.maxIterations).toBe(1);
    });

    it("should handle very large maxIterations", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_MAX_ITERATIONS: "1000" });
      expect(config.maxIterations).toBe(1000);
    });

    it("should handle invalid maxIterations (NaN)", async () => {
      const { configFromEnv, DEFAULT_CONFIG } = await import("../client");
      const config = configFromEnv({
        ELIZA_RLM_MAX_ITERATIONS: "not_a_number",
      });
      expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
    });

    it("should handle zero maxIterations", async () => {
      const { configFromEnv, DEFAULT_CONFIG } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_MAX_ITERATIONS: "0" });
      // parseInt("0") = 0, which is falsy, so falls back to default
      expect(config.maxIterations).toBe(DEFAULT_CONFIG.maxIterations);
    });

    it("should handle negative maxIterations", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_MAX_ITERATIONS: "-5" });
      // parseInt("-5") = -5, which is truthy
      expect(config.maxIterations).toBe(-5);
    });
  });

  describe("Message Normalization Edge Cases", () => {
    it("should handle empty string", async () => {
      const { RLMClient } = await import("../client");
      const messages = RLMClient.normalizeMessages("");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("");
    });

    it("should handle empty array", async () => {
      const { RLMClient } = await import("../client");
      const messages = RLMClient.normalizeMessages([]);
      expect(messages).toHaveLength(0);
    });

    it("should handle whitespace-only string", async () => {
      const { RLMClient } = await import("../client");
      const messages = RLMClient.normalizeMessages("   \n\t  ");
      expect(messages[0].content).toBe("   \n\t  ");
    });

    it("should handle unicode characters", async () => {
      const { RLMClient } = await import("../client");
      const unicodeText = "Hello 世界 🌍 مرحبا";
      const messages = RLMClient.normalizeMessages(unicodeText);
      expect(messages[0].content).toBe(unicodeText);
    });

    it("should handle very long string (100k chars)", async () => {
      const { RLMClient } = await import("../client");
      const longText = "x".repeat(100000);
      const messages = RLMClient.normalizeMessages(longText);
      expect(messages[0].content.length).toBe(100000);
    });

    it("should handle single message in array", async () => {
      const { RLMClient } = await import("../client");
      const messages = RLMClient.normalizeMessages([{ role: "user" as const, content: "single" }]);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("single");
    });
  });

  describe("Verbose Flag Truthy Values", () => {
    it("should recognize '1' as truthy", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_VERBOSE: "1" });
      expect(config.verbose).toBe(true);
    });

    it("should recognize 'true' as truthy", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_VERBOSE: "true" });
      expect(config.verbose).toBe(true);
    });

    it("should recognize 'yes' as truthy", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_VERBOSE: "yes" });
      expect(config.verbose).toBe(true);
    });

    it("should recognize 'TRUE' (uppercase) as truthy", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_VERBOSE: "TRUE" });
      expect(config.verbose).toBe(true);
    });

    it("should recognize '0' as falsy", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_VERBOSE: "0" });
      expect(config.verbose).toBe(false);
    });

    it("should recognize 'false' as falsy", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_VERBOSE: "false" });
      expect(config.verbose).toBe(false);
    });

    it("should recognize empty string as falsy", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({ ELIZA_RLM_VERBOSE: "" });
      expect(config.verbose).toBe(false);
    });
  });
});

describe("Config Validation", () => {
  it("should validate valid backends", async () => {
    const { validateConfig, VALID_BACKENDS } = await import("../types");

    for (const backend of VALID_BACKENDS) {
      const errors = validateConfig({ backend });
      expect(errors).toHaveLength(0);
    }
  });

  it("should reject invalid backend", async () => {
    const { validateConfig } = await import("../types");
    const errors = validateConfig({ backend: "invalid_backend" as never });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Invalid backend");
  });

  it("should validate valid environments", async () => {
    const { validateConfig, VALID_ENVIRONMENTS } = await import("../types");

    for (const environment of VALID_ENVIRONMENTS) {
      const errors = validateConfig({ environment });
      expect(errors).toHaveLength(0);
    }
  });

  it("should reject invalid environment", async () => {
    const { validateConfig } = await import("../types");
    const errors = validateConfig({ environment: "invalid_env" as never });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("Invalid environment");
  });

  it("should reject negative maxIterations", async () => {
    const { validateConfig } = await import("../types");
    const errors = validateConfig({ maxIterations: -1 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should reject zero maxIterations", async () => {
    const { validateConfig } = await import("../types");
    const errors = validateConfig({ maxIterations: 0 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should accept maxIterations of 1", async () => {
    const { validateConfig } = await import("../types");
    const errors = validateConfig({ maxIterations: 1 });
    expect(errors).toHaveLength(0);
  });

  it("should reject retryMaxDelay less than retryBaseDelay", async () => {
    const { validateConfig } = await import("../types");
    const errors = validateConfig({
      retryBaseDelay: 5000,
      retryMaxDelay: 1000,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("retryMaxDelay");
  });

  it("should throw in strict mode", async () => {
    const { validateConfig, RLMConfigError } = await import("../types");

    expect(() => {
      validateConfig({ backend: "invalid" as never }, true);
    }).toThrow(RLMConfigError);
  });
});

describe("Error Handling", () => {
  describe("Client Initialization Errors", () => {
    it("should handle invalid python path gracefully", async () => {
      const { RLMClient } = await import("../client");

      // Should not throw
      const client = new RLMClient({
        pythonPath: "/nonexistent/path/to/python",
      });
      expect(client).toBeDefined();
    });

    it("should return stub result when python unavailable", async () => {
      const { RLMClient } = await import("../client");
      const client = new RLMClient({ pythonPath: "/nonexistent/python" });

      const result = await client.infer("test");
      expect(result.metadata.stub).toBe(true);
    });
  });

  describe("Stub Result Error Messages", () => {
    it("should include specific error message in stub", async () => {
      const { stubResult } = await import("../client");
      const errorMsg = "Custom error message";
      const result = stubResult(errorMsg);

      expect(result.metadata.error).toBe(errorMsg);
    });

    it("should have undefined error for default stub", async () => {
      const { stubResult } = await import("../client");
      const result = stubResult();

      expect(result.metadata.error).toBeUndefined();
    });
  });
});

describe("Concurrent Behavior", () => {
  it("should handle multiple concurrent infer calls", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    // Make 5 concurrent calls
    const promises = [
      client.infer("Message 1"),
      client.infer("Message 2"),
      client.infer("Message 3"),
      client.infer("Message 4"),
      client.infer("Message 5"),
    ];

    const results = await Promise.all(promises);

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.metadata.stub).toBe(true);
    }
  });

  it("should correctly track metrics across concurrent calls", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    await Promise.all([client.infer("test1"), client.infer("test2"), client.infer("test3")]);

    const metrics = client.getMetrics();
    expect(metrics.totalRequests).toBe(3);
    expect(metrics.stubResponses).toBe(3);
  });
});

describe("Output Verification", () => {
  describe("Stub Response Format", () => {
    it("should have exact stub format", async () => {
      const { stubResult } = await import("../client");
      const result = stubResult();

      expect(result.text).toMatch(/^\[RLM STUB\]/);
      expect(result.metadata.stub).toBe(true);
      expect(result.metadata.iterations).toBeUndefined();
      expect(result.metadata.depth).toBeUndefined();
    });
  });

  describe("Metrics Structure", () => {
    it("should have all required metric fields", async () => {
      const { RLMClient } = await import("../client");
      const client = new RLMClient({ pythonPath: "/nonexistent/python" });

      const metrics = client.getMetrics();

      expect(typeof metrics.totalRequests).toBe("number");
      expect(typeof metrics.successfulRequests).toBe("number");
      expect(typeof metrics.failedRequests).toBe("number");
      expect(typeof metrics.stubResponses).toBe("number");
      expect(typeof metrics.totalRetries).toBe("number");
      expect(typeof metrics.averageLatencyMs).toBe("number");
      expect(typeof metrics.p95LatencyMs).toBe("number");
      expect(typeof metrics.lastRequestTimestamp).toBe("number");
    });

    it("should update lastRequestTimestamp after infer", async () => {
      const { RLMClient } = await import("../client");
      const client = new RLMClient({ pythonPath: "/nonexistent/python" });

      const before = Date.now();
      await client.infer("test");
      const metrics = client.getMetrics();

      expect(metrics.lastRequestTimestamp).toBeGreaterThanOrEqual(before);
      expect(metrics.lastRequestTimestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("Config Values Preserved", () => {
    it("should preserve exact config values", async () => {
      const { configFromEnv } = await import("../client");
      const config = configFromEnv({
        ELIZA_RLM_BACKEND: "anthropic",
        ELIZA_RLM_ENV: "docker",
        ELIZA_RLM_MAX_ITERATIONS: "7",
        ELIZA_RLM_MAX_DEPTH: "3",
        ELIZA_RLM_PYTHON_PATH: "/custom/python/path",
        ELIZA_RLM_MAX_RETRIES: "5",
        ELIZA_RLM_RETRY_BASE_DELAY: "2000",
        ELIZA_RLM_RETRY_MAX_DELAY: "60000",
      });

      expect(config.backend).toBe("anthropic");
      expect(config.environment).toBe("docker");
      expect(config.maxIterations).toBe(7);
      expect(config.maxDepth).toBe(3);
      expect(config.pythonPath).toBe("/custom/python/path");
      expect(config.maxRetries).toBe(5);
      expect(config.retryBaseDelay).toBe(2000);
      expect(config.retryMaxDelay).toBe(60000);
    });
  });
});

describe("ENV_VARS Constants", () => {
  it("should have all retry-related env vars", async () => {
    const { ENV_VARS } = await import("../types");

    expect(ENV_VARS.MAX_RETRIES).toBe("ELIZA_RLM_MAX_RETRIES");
    expect(ENV_VARS.RETRY_BASE_DELAY).toBe("ELIZA_RLM_RETRY_BASE_DELAY");
    expect(ENV_VARS.RETRY_MAX_DELAY).toBe("ELIZA_RLM_RETRY_MAX_DELAY");
  });
});

describe("DEFAULT_CONFIG Completeness", () => {
  it("should have all required fields with valid values", async () => {
    const { DEFAULT_CONFIG, VALID_BACKENDS, VALID_ENVIRONMENTS } = await import("../types");

    // Verify backend is valid
    expect(VALID_BACKENDS).toContain(DEFAULT_CONFIG.backend);

    // Verify environment is valid
    expect(VALID_ENVIRONMENTS).toContain(DEFAULT_CONFIG.environment);

    // Verify numeric fields are positive
    expect(DEFAULT_CONFIG.maxIterations).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.maxDepth).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.maxRetries).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.retryBaseDelay).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_CONFIG.retryMaxDelay).toBeGreaterThanOrEqual(DEFAULT_CONFIG.retryBaseDelay);

    // Verify pythonPath is set
    expect(DEFAULT_CONFIG.pythonPath).toBeTruthy();
  });
});

// ============================================================================
// NEW FEATURES: Per-request overrides (Paper Algorithm 1)
// ============================================================================

describe("RLMInferOptions Per-Request Overrides", () => {
  it("should support maxIterations override", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    // Should accept per-request maxIterations
    const result = await client.infer("test", { maxIterations: 10 });
    expect(result.metadata.stub).toBe(true);
  });

  it("should support maxDepth override", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    // Should accept per-request maxDepth
    const result = await client.infer("test", { maxDepth: 5 });
    expect(result.metadata.stub).toBe(true);
  });

  it("should support rootModel override", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    // Should accept per-request rootModel
    const result = await client.infer("test", { rootModel: "gpt-5" });
    expect(result.metadata.stub).toBe(true);
  });

  it("should support subcallModel override", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    // Should accept per-request subcallModel
    const result = await client.infer("test", { subcallModel: "gpt-5-mini" });
    expect(result.metadata.stub).toBe(true);
  });

  it("should support logTrajectories override", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    // Should accept per-request logTrajectories
    const result = await client.infer("test", { logTrajectories: true });
    expect(result.metadata.stub).toBe(true);
  });

  it("should support multiple overrides simultaneously", async () => {
    const { RLMClient } = await import("../client");
    const client = new RLMClient({ pythonPath: "/nonexistent/python" });

    // Should accept multiple per-request overrides
    const result = await client.infer("test", {
      maxIterations: 10,
      maxDepth: 3,
      rootModel: "gpt-5",
      subcallModel: "gpt-5-mini",
      logTrajectories: true,
      trackCosts: true,
    });
    expect(result.metadata.stub).toBe(true);
  });

  // NOTE: Custom REPL tool injection is NOT supported by the upstream RLM library.
  // See: https://arxiv.org/abs/2512.24601 Section 3.3 - the paper describes the concept
  // but the current library implementation does not expose this capability.
});

describe("RLMInferOptions Type Definition", () => {
  it("should have all new override fields", async () => {
    // This is a compile-time type check - if it compiles, the types are correct
    const opts: import("../types").RLMInferOptions = {
      maxIterations: 10,
      maxDepth: 3,
      rootModel: "gpt-5",
      subcallModel: "gpt-5-mini",
      logTrajectories: true,
      trackCosts: true,
    };
    expect(opts.maxIterations).toBe(10);
    expect(opts.maxDepth).toBe(3);
  });
});
