/**
 * GET /api/runtime walks the live runtime via serializeForRuntimeDebug.
 * character.secrets and settings.secrets (and any isSensitiveConfigKey match)
 * must be masked the same way /api/config already redacts, so a paired USER
 * session cannot read cleartext API keys from the debug snapshot.
 */
import { expect, it } from "vitest";
import { serializeForRuntimeDebug } from "../src/api/health-routes.ts";

const OPTIONS = {
  maxDepth: 10,
  maxArrayLength: 100,
  maxObjectEntries: 100,
  maxStringLength: 8000,
} as const;

it("redacts sensitive keys in the runtime debug snapshot and keeps normal fields", () => {
  const snapshot = serializeForRuntimeDebug(
    {
      character: {
        secrets: {
          OPENAI_API_KEY: "sk-live-must-not-appear",
        },
        name: "AgentX",
      },
      settings: {
        secrets: {
          DISCORD_TOKEN: "discord-must-not-appear",
        },
        theme: "dark",
      },
      plainNote: "visible",
    },
    OPTIONS,
  );

  const encoded = JSON.stringify(snapshot);
  expect(encoded).not.toContain("sk-live-must-not-appear");
  expect(encoded).not.toContain("discord-must-not-appear");
  expect(encoded).toContain("[REDACTED]");
  expect(encoded).toContain("AgentX");
  expect(encoded).toContain("dark");
  expect(encoded).toContain("visible");

  const record = snapshot as Record<string, unknown>;
  const character = record.character as Record<string, unknown>;
  const secrets = character.secrets as Record<string, unknown>;
  expect(secrets.OPENAI_API_KEY).toBe("[REDACTED]");
  expect(character.name).toBe("AgentX");
});

it("redacts Map values whose string keys are sensitive", () => {
  const snapshot = serializeForRuntimeDebug(
    {
      bag: new Map<string, string>([
        ["OPENAI_API_KEY", "sk-map-must-not-appear"],
        ["label", "keep-me"],
      ]),
    },
    OPTIONS,
  );

  const encoded = JSON.stringify(snapshot);
  expect(encoded).not.toContain("sk-map-must-not-appear");
  expect(encoded).toContain("keep-me");
  expect(encoded).toContain("[REDACTED]");
});
