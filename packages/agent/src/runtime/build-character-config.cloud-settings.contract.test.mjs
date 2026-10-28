import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "@elizaos/core";
import { buildCharacterFromConfig } from "./build-character-config.ts";

const keys = [
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_API_KEY",
  "MATRIX_AUTO_REPLY",
];
function withEnv(values, run) {
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return run();
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

for (const enabled of ["true", "false"]) {
  test(`Cloud ${enabled} and endpoint stay readable without becoming secrets`, () =>
    withEnv(
      {
        ELIZAOS_CLOUD_ENABLED: enabled,
        ELIZAOS_CLOUD_BASE_URL: "https://cloud.example.invalid",
        ELIZAOS_CLOUD_API_KEY: "synthetic-cloud-credential-for-contract",
        MATRIX_AUTO_REPLY: "false",
      },
      () => {
        const character = buildCharacterFromConfig({});
        assert.equal(
          character.secrets?.ELIZAOS_CLOUD_API_KEY,
          "synthetic-cloud-credential-for-contract",
        );
        for (const key of ["ELIZAOS_CLOUD_ENABLED", "ELIZAOS_CLOUD_BASE_URL"]) {
          assert.equal(Object.hasOwn(character.secrets ?? {}, key), false);
          assert.equal(
            Object.hasOwn(character.settings?.secrets ?? {}, key),
            false,
          );
        }
        // Remove env fallback: the built character itself must retain these values.
        for (const key of keys) delete process.env[key];
        const runtime = new AgentRuntime({ character, logLevel: "fatal" });
        assert.equal(
          runtime.getSetting("ELIZAOS_CLOUD_ENABLED"),
          enabled === "true",
        );
        assert.equal(
          runtime.getSetting("ELIZAOS_CLOUD_BASE_URL"),
          "https://cloud.example.invalid",
        );
        assert.equal(
          runtime.getSetting("ELIZAOS_CLOUD_API_KEY"),
          "synthetic-cloud-credential-for-contract",
        );
        assert.equal(runtime.getSetting("MATRIX_AUTO_REPLY"), false);
      },
    ));
}

test("absent and blank Cloud environment values do not add settings or secrets", () =>
  withEnv(
    {
      ELIZAOS_CLOUD_ENABLED: "  ",
      ELIZAOS_CLOUD_BASE_URL: "",
      ELIZAOS_CLOUD_API_KEY: "  ",
    },
    () => {
      const character = buildCharacterFromConfig({});
      for (const key of keys.slice(0, 3)) {
        assert.equal(Object.hasOwn(character.secrets ?? {}, key), false);
        assert.equal(Object.hasOwn(character.settings ?? {}, key), false);
        assert.equal(
          Object.hasOwn(character.settings?.extra ?? {}, key),
          false,
        );
      }
    },
  ));

test("configured public Cloud values survive when no environment overrides exist", () =>
  withEnv({}, () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [
          {
            id: "main",
            settings: {
              ELIZAOS_CLOUD_ENABLED: false,
              ELIZAOS_CLOUD_BASE_URL: "https://configured.example.invalid",
            },
          },
        ],
      },
    });
    const runtime = new AgentRuntime({ character, logLevel: "fatal" });
    assert.equal(runtime.getSetting("ELIZAOS_CLOUD_ENABLED"), false);
    assert.equal(
      runtime.getSetting("ELIZAOS_CLOUD_BASE_URL"),
      "https://configured.example.invalid",
    );
    assert.equal(
      Object.hasOwn(character.secrets ?? {}, "ELIZAOS_CLOUD_BASE_URL"),
      false,
    );
  }));
