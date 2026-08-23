/**
 * Unit tests for API server config redaction and sensitive key filtering.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CONFIG_FILTER_UNBOUNDED,
  filterConfigEnvForResponse,
  SENSITIVE_ENV_RESPONSE_KEYS,
} from "./server-config-filter.js";

describe("server-config-filter", () => {
  it("redacts sensitive keys in object properties", () => {
    const config = {
      name: "test-agent",
      apiKey: "sk-live-12345",
      database: {
        password: "secret_db_password",
        connectionString: "postgres://user:pass@localhost/db",
        host: "localhost",
      },
    };

    const filtered = filterConfigEnvForResponse(config);

    expect(filtered.name).toBe("test-agent");
    expect(filtered.apiKey).toBe("[REDACTED]");
    expect(filtered.database).toEqual({
      password: "[REDACTED]",
      connectionString: "[REDACTED]",
      host: "localhost",
    });
  });

  it("strips SENSITIVE_ENV_RESPONSE_KEYS from env block", () => {
    const config = {
      env: {
        PUBLIC_URL: "https://example.com",
        EVM_PRIVATE_KEY: "0x12345",
        GITHUB_TOKEN: "ghp_abc",
        PORT: 3000,
      },
    };

    const filtered = filterConfigEnvForResponse(config);
    const env = filtered.env as Record<string, unknown>;

    expect(env.PUBLIC_URL).toBe("https://example.com");
    expect(env.PORT).toBe(3000);
    expect("EVM_PRIVATE_KEY" in env).toBe(false);
    expect("GITHUB_TOKEN" in env).toBe(false);
  });

  it("fails with ElizaError when cyclic graphs are encountered", () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;

    try {
      filterConfigEnvForResponse(cyclic);
      expect.unreachable("should have thrown ElizaError");
    } catch (err) {
      expect(err).toBeInstanceOf(ElizaError);
      expect((err as ElizaError).code).toBe(CONFIG_FILTER_UNBOUNDED);
    }
  });

  it("preserves empty values without crashing", () => {
    const emptyConfig = {};
    expect(filterConfigEnvForResponse(emptyConfig)).toEqual({});

    const configWithEmptyFields = {
      emptyString: "",
      nullField: null,
      undefinedField: undefined,
    };
    expect(filterConfigEnvForResponse(configWithEmptyFields)).toEqual({
      emptyString: "",
      nullField: null,
      undefinedField: undefined,
    });
  });

  it("exports known sensitive env response keys", () => {
    expect(SENSITIVE_ENV_RESPONSE_KEYS.has("EVM_PRIVATE_KEY")).toBe(true);
    expect(SENSITIVE_ENV_RESPONSE_KEYS.has("DATABASE_URL")).toBe(true);
    expect(SENSITIVE_ENV_RESPONSE_KEYS.has("ELIZAOS_CLOUD_API_KEY")).toBe(true);
  });
});
