// Exercises reserved env keys behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  findReservedEnvKeys,
  RESERVED_PLATFORM_ENV_KEYS,
  stripReservedEnvKeys,
} from "./reserved-env-keys";

describe("reserved-env-keys", () => {
  test("findReservedEnvKeys flags reserved keys case-insensitively, echoing caller casing", () => {
    expect(findReservedEnvKeys(["database_url", "ELIZAOS_CLOUD_API_KEY", "MY_VAR"])).toEqual([
      "database_url",
      "ELIZAOS_CLOUD_API_KEY",
    ]);
  });

  test("findReservedEnvKeys returns [] when no reserved keys present", () => {
    expect(findReservedEnvKeys(["FOO", "BAR"])).toEqual([]);
  });

  test("Steward keyless config is platform-owned but OpenAI shim keys remain mode-specific", () => {
    expect(
      findReservedEnvKeys([
        "STEWARD_API_URL",
        "STEWARD_INVOKE_URL",
        "STEWARD_CAPABILITIES",
        "STEWARD_CAP_OPENAI_CHAT",
        "STEWARD_KEYLESS_MODE",
        "STEWARD_KEYLESS_SERVICES",
        "STEWARD_JWT",
        "STEWARD_REFRESH_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
      ]),
    ).toEqual([
      "STEWARD_API_URL",
      "STEWARD_INVOKE_URL",
      "STEWARD_CAPABILITIES",
      "STEWARD_CAP_OPENAI_CHAT",
      "STEWARD_KEYLESS_MODE",
      "STEWARD_KEYLESS_SERVICES",
      "STEWARD_JWT",
      "STEWARD_REFRESH_URL",
    ]);
  });

  test("POSTGRES_URL is not in the default platform list but can be added per-caller", () => {
    expect(findReservedEnvKeys(["postgres_url"])).toEqual([]);
    expect(
      findReservedEnvKeys(["postgres_url"], [...RESERVED_PLATFORM_ENV_KEYS, "POSTGRES_URL"]),
    ).toEqual(["postgres_url"]);
  });

  test("stripReservedEnvKeys removes reserved keys (case-insensitive) and keeps the rest", () => {
    expect(
      stripReservedEnvKeys({
        DATABASE_URL: "postgres://evil",
        database_url: "postgres://evil2",
        ELIZAOS_CLOUD_API_KEY: "stolen",
        APP_SECRET: "keep-me",
        LOG_LEVEL: "debug",
      }),
    ).toEqual({ APP_SECRET: "keep-me", LOG_LEVEL: "debug" });
  });

  test("stripReservedEnvKeys with an extended set also strips POSTGRES_URL", () => {
    expect(
      stripReservedEnvKeys({ POSTGRES_URL: "postgres://evil", KEEP: "1" }, [
        ...RESERVED_PLATFORM_ENV_KEYS,
        "POSTGRES_URL",
      ]),
    ).toEqual({ KEEP: "1" });
  });

  test("stripReservedEnvKeys does not mutate its input", () => {
    const input = { DATABASE_URL: "x", KEEP: "1" };
    expect(stripReservedEnvKeys(input)).toEqual({ KEEP: "1" });
    expect(input).toEqual({ DATABASE_URL: "x", KEEP: "1" });
  });
});
