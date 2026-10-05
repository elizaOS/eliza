/** Exercises the agent transfer bundle's secret contract against real PGlite: a default migration bundle carries and restores both secret containers, and an explicit credential-free export removes them from the encrypted payload and from the imported agent. */
import * as crypto from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it } from "vitest";
import { exportAgent, importAgent } from "../src/services/agent-export.ts";

const PASSWORD = "transfer-password-ok";
const SETTINGS_SECRET = "sk-settings-secret-value";
const MAGIC_LENGTH = Buffer.from("ELIZA_AGENT_V1\n", "utf-8").length;

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;

beforeAll(async () => {
  fixture = await createTestRuntime({ characterName: "TransferSecrets" });
  const stored = await fixture.runtime.getAgent(fixture.runtime.agentId);
  if (!stored) throw new Error("Test agent was not persisted");
  await fixture.runtime.updateAgent(fixture.runtime.agentId, {
    settings: {
      ...(stored.settings ?? {}),
      transferMarker: "kept",
      secrets: { OPENAI_API_KEY: SETTINGS_SECRET },
    },
  });
}, 180_000);

afterAll(async () => {
  if (fixture) await fixture.cleanup();
}, 120_000);

function decryptBundle(file: Buffer): string {
  let offset = MAGIC_LENGTH;
  const iterations = file.readUInt32BE(offset);
  offset += 4;
  const salt = file.subarray(offset, offset + 32);
  offset += 32;
  const iv = file.subarray(offset, offset + 12);
  offset += 12;
  const tag = file.subarray(offset, offset + 16);
  offset += 16;
  const key = crypto.pbkdf2Sync(PASSWORD, salt, iterations, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(tag);
  return gunzipSync(
    Buffer.concat([decipher.update(file.subarray(offset)), decipher.final()]),
  ).toString("utf-8");
}

async function importedSettings(file: Buffer) {
  const result = await importAgent(fixture.runtime, file, PASSWORD);
  expect(result.success).toBe(true);
  const imported = await fixture.runtime.getAgent(result.agentId as UUID);
  if (!imported) throw new Error("Imported agent was not persisted");
  return imported.settings ?? {};
}

it("carries and restores settings secrets in a default migration bundle", async () => {
  const file = await exportAgent(fixture.runtime, PASSWORD);
  expect(decryptBundle(file)).toContain(SETTINGS_SECRET);

  const settings = await importedSettings(file);
  expect(settings.transferMarker).toBe("kept");
  expect(settings.secrets).toEqual(
    expect.objectContaining({ OPENAI_API_KEY: SETTINGS_SECRET }),
  );
}, 120_000);

it("removes both secret containers from an explicit credential-free export", async () => {
  const file = await exportAgent(fixture.runtime, PASSWORD, {
    excludeSecrets: true,
  });
  const json = decryptBundle(file);
  expect(json).not.toContain(SETTINGS_SECRET);
  const payload = JSON.parse(json) as {
    agent: { secrets?: unknown; settings?: Record<string, unknown> };
    characterConfig?: { secrets?: unknown; settings?: Record<string, unknown> };
  };
  expect(payload.agent.secrets).toBeUndefined();
  expect(payload.agent.settings?.secrets).toBeUndefined();
  expect(payload.agent.settings?.transferMarker).toBe("kept");
  expect(payload.characterConfig?.secrets).toBeUndefined();
  expect(payload.characterConfig?.settings?.secrets).toBeUndefined();

  const settings = await importedSettings(file);
  expect(settings.transferMarker).toBe("kept");
  expect(JSON.stringify(settings)).not.toContain(SETTINGS_SECRET);
}, 120_000);
