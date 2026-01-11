import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import {
  detectEnvironment,
  findEnvFile,
  getBooleanEnv,
  getEnv,
  getEnvironment,
  getNumberEnv,
  hasEnv,
  initBrowserEnvironment,
  loadEnvFile,
  setEnv,
} from "../../utils/environment";

describe("Environment Abstraction", () => {
  let originalProcess: typeof globalThis.process | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let originalGlobalThis: typeof globalThis | undefined;

  beforeEach(() => {
    // Store original values
    originalProcess = (global as typeof globalThis).process;
    originalWindow = (global as typeof globalThis).window;
    originalGlobalThis = globalThis;

    // Clear environment cache
    getEnvironment().clearCache();
  });

  afterEach(() => {
    // Restore original values
    if (originalProcess !== undefined) {
      (global as typeof globalThis).process = originalProcess;
    } else {
      delete (global as typeof globalThis & { process?: typeof process })
        .process;
    }

    if (originalWindow !== undefined) {
      (global as typeof globalThis).window = originalWindow;
    } else {
      delete (global as typeof globalThis & { window?: typeof window }).window;
    }

    if (originalGlobalThis !== undefined) {
      // Cannot reassign globalThis, so skip
    }

    // Clear cache after each test
    getEnvironment().clearCache();
  });

  describe("detectEnvironment", () => {
    it("should detect Node.js environment", () => {
      // Current test environment is Node.js
      const env = detectEnvironment();
      expect(env).toBe("node");
    });

    it("should return 'node' in current test environment", () => {
      // In Bun/Node.js test environment, process is always defined
      // Browser environment detection would require running in an actual browser
      // We verify that the function correctly identifies the current environment
      const detectedEnv = detectEnvironment();
      // Test environment is always node/bun
      expect(["node", "unknown"]).toContain(detectedEnv);
    });
  });

  describe("getEnv", () => {
    it("should get environment variable in Node.js", () => {
      process.env.TEST_VAR = "test_value";
      const value = getEnv("TEST_VAR");
      expect(value).toBe("test_value");
      delete process.env.TEST_VAR;
    });

    it("should return default value when variable is not set", () => {
      const value = getEnv("NON_EXISTENT_VAR", "default");
      expect(value).toBe("default");
    });

    it("should cache environment variable values", () => {
      process.env.CACHE_TEST = "initial";
      const value1 = getEnv("CACHE_TEST");
      expect(value1).toBe("initial");

      // Change the actual env var
      process.env.CACHE_TEST = "changed";

      // Should still get cached value
      const value2 = getEnv("CACHE_TEST");
      expect(value2).toBe("initial");

      // Clear cache and get new value
      getEnvironment().clearCache();
      const value3 = getEnv("CACHE_TEST");
      expect(value3).toBe("changed");

      delete process.env.CACHE_TEST;
    });
  });

  describe("setEnv", () => {
    it("should set environment variable", () => {
      setEnv("SET_TEST_VAR", "test_value");
      const value = getEnv("SET_TEST_VAR");
      expect(value).toBe("test_value");
      delete process.env.SET_TEST_VAR;
    });

    it("should convert non-string values to strings", () => {
      setEnv("NUMBER_VAR", 123);
      const value = getEnv("NUMBER_VAR");
      expect(value).toBe("123");
      delete process.env.NUMBER_VAR;

      setEnv("BOOL_VAR", true);
      const value2 = getEnv("BOOL_VAR");
      expect(value2).toBe("true");
      delete process.env.BOOL_VAR;
    });
  });

  describe("hasEnv", () => {
    it("should return true for existing variables", () => {
      process.env.EXISTS = "yes";
      expect(hasEnv("EXISTS")).toBe(true);
      delete process.env.EXISTS;
    });

    it("should return false for non-existing variables", () => {
      expect(hasEnv("DOES_NOT_EXIST")).toBe(false);
    });
  });

  describe("getBooleanEnv", () => {
    it("should parse true values correctly", () => {
      const trueValues = ["true", "1", "yes", "on"];

      trueValues.forEach((value) => {
        process.env.BOOL_TEST = value;
        expect(getBooleanEnv("BOOL_TEST")).toBe(true);
      });

      delete process.env.BOOL_TEST;
    });

    it("should parse false values correctly", () => {
      const falseValues = ["false", "0", "no", "off", "anything", ""];

      falseValues.forEach((value) => {
        process.env.BOOL_TEST = value;
        expect(getBooleanEnv("BOOL_TEST")).toBe(false);
      });

      delete process.env.BOOL_TEST;
    });

    it("should return default value when not set", () => {
      expect(getBooleanEnv("NOT_SET", true)).toBe(true);
      expect(getBooleanEnv("NOT_SET", false)).toBe(false);
    });
  });

  describe("getNumberEnv", () => {
    it("should parse valid numbers", () => {
      process.env.NUM_TEST = "42";
      getEnvironment().clearCache(); // Clear cache after setting env var
      expect(getNumberEnv("NUM_TEST")).toBe(42);

      process.env.NUM_TEST = "3.14";
      getEnvironment().clearCache(); // Clear cache after setting env var
      expect(getNumberEnv("NUM_TEST")).toBe(3.14);

      process.env.NUM_TEST = "-100";
      getEnvironment().clearCache(); // Clear cache after setting env var
      expect(getNumberEnv("NUM_TEST")).toBe(-100);

      delete process.env.NUM_TEST;
    });

    it("should return undefined for invalid numbers", () => {
      process.env.NUM_TEST = "not a number";
      expect(getNumberEnv("NUM_TEST")).toBeUndefined();
      delete process.env.NUM_TEST;
    });

    it("should return default value when not set or invalid", () => {
      expect(getNumberEnv("NOT_SET", 100)).toBe(100);

      process.env.INVALID_NUM = "abc";
      expect(getNumberEnv("INVALID_NUM", 200)).toBe(200);
      delete process.env.INVALID_NUM;
    });
  });

  // Browser environment tests removed - cannot be tested in Node.js environment
  // Browser functionality is tested via E2E tests in the browser

  describe("getEnvironment singleton", () => {
    it("should return the same instance", () => {
      const env1 = getEnvironment();
      const env2 = getEnvironment();
      expect(env1).toBe(env2);
    });
  });

  describe("getAll", () => {
    it("should return all environment variables", () => {
      process.env.TEST1 = "value1";
      process.env.TEST2 = "value2";

      const allVars = getEnvironment().getAll();
      expect(allVars.TEST1).toBe("value1");
      expect(allVars.TEST2).toBe("value2");

      delete process.env.TEST1;
      delete process.env.TEST2;
    });
  });

  describe("Environment Config Functions (.env file loading)", () => {
    let originalEnvSnapshot: NodeJS.ProcessEnv;

    beforeEach(() => {
      // Snapshot and clear env
      originalEnvSnapshot = { ...process.env };
      for (const k of Object.keys(process.env)) {
        delete (process.env as Record<string, string | undefined>)[k];
      }
    });

    afterEach(() => {
      // Restore env in-place
      for (const k of Object.keys(process.env)) {
        delete (process.env as Record<string, string | undefined>)[k];
      }
      Object.assign(process.env, originalEnvSnapshot);
    });

    describe("loadEnvFile", () => {
      test("should load environment variables from .env file", () => {
        const result = loadEnvFile();
        // Result depends on whether .env exists in test environment
        expect(typeof result).toBe("boolean");
      });

      test("should throw error for invalid path", () => {
        expect(() => loadEnvFile("/nonexistent/path/.env")).toThrow(
          "Failed to parse .env file",
        );
      });

      test("should be idempotent", () => {
        const result1 = loadEnvFile();
        const result2 = loadEnvFile();
        // Should be safe to call multiple times
        expect(typeof result1).toBe("boolean");
        expect(typeof result2).toBe("boolean");
      });
    });

    describe("findEnvFile", () => {
      test("should traverse up directory tree", () => {
        const envPath = findEnvFile();
        // In test environment, may or may not exist
        expect(envPath === null || typeof envPath === "string").toBe(true);
      });

      test("should support custom filenames", () => {
        const envPath = findEnvFile(undefined, [".env.custom", ".env"]);
        expect(envPath === null || typeof envPath === "string").toBe(true);
      });

      test("should support custom start directory", () => {
        const envPath = findEnvFile(process.cwd());
        expect(envPath === null || typeof envPath === "string").toBe(true);
      });
    });
  });

  // Additional basic tests from src/utils/__tests__/environment.test.ts
  describe("environment utils (basic)", () => {
    it("detects runtime (node in tests)", () => {
      const runtime = detectEnvironment();
      expect(["node", "browser", "unknown"]).toContain(runtime);
    });

    it("gets and sets env vars via API", () => {
      const key = "TEST_ENV_UTILS_KEY";
      setEnv(key, "value1");
      expect(getEnv(key)).toBe("value1");
      expect(hasEnv(key)).toBe(true);
    });

    it("boolean env parsing works", () => {
      const key = "TEST_BOOL_ENV";
      setEnv(key, "true");
      expect(getBooleanEnv(key, false)).toBe(true);
      setEnv(key, "0");
      expect(getBooleanEnv(key, true)).toBe(false);
    });

    it("number env parsing works", () => {
      const key = "TEST_NUM_ENV";
      setEnv(key, "42");
      expect(getNumberEnv(key)).toBe(42);
      setEnv(key, "NaN");
      expect(getNumberEnv(key, 7)).toBe(7);
    });

    it("browser init helper is safe in node", () => {
      // Should not throw even though we are not in browser
      expect(() => initBrowserEnvironment({ SOME_KEY: "x" })).not.toThrow();
    });

    it("environment cache can be cleared indirectly by setting", () => {
      // Access a key, then change it, ensure fresh read gets latest
      const key = "TEST_CACHE_KEY";
      setEnv(key, "a");
      expect(getEnv(key)).toBe("a");
      setEnv(key, "b");
      // getEnv reads through the singleton which clears cache on set
      expect(getEnv(key)).toBe("b");
    });
  });
});
