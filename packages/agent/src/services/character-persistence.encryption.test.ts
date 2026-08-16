/**
 * Proves the character-persistence sink encrypts secret settings before they
 * are embedded in the agent row's `metadata.character` snapshot. The harness is
 * integration-backed: it drives the real ElizaCharacterPersistenceService with a
 * temp-dir eliza.json and a captured `updateAgent`, so the assertions exercise
 * the actual persistence path rather than a re-implementation. Secret values are
 * synthetic; nothing real is leaked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Character,
  clearSaltCache,
  decryptedCharacter,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElizaCharacterPersistenceService } from "./character-persistence.ts";

const TEST_SALT = "character-persistence-encryption-test-salt";
const OPENAI_SECRET = "sk-openai-persistence-do-not-leak-abc123";
const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

describe("ElizaCharacterPersistenceService secret encryption", () => {
  let tempDir: string;
  let previousSalt: string | undefined;
  let previousConfigPath: string | undefined;
  let previousPersistPath: string | undefined;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "char-persist-enc-"));
    previousSalt = process.env.SECRET_SALT;
    previousConfigPath = process.env.ELIZA_CONFIG_PATH;
    previousPersistPath = process.env.ELIZA_PERSIST_CONFIG_PATH;
    previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.SECRET_SALT = TEST_SALT;
    process.env.ELIZA_CONFIG_PATH = join(tempDir, "eliza.json");
    process.env.ELIZA_PERSIST_CONFIG_PATH = join(tempDir, "eliza.persist.json");
    process.env.ELIZA_STATE_DIR = tempDir;
    clearSaltCache();
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("SECRET_SALT", previousSalt);
    restore("ELIZA_CONFIG_PATH", previousConfigPath);
    restore("ELIZA_PERSIST_CONFIG_PATH", previousPersistPath);
    restore("ELIZA_STATE_DIR", previousStateDir);
    clearSaltCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("encrypts settings.secrets in the persisted metadata without mutating the input", async () => {
    const character: Character = {
      name: "Persisted Secret Keeper",
      bio: ["An agent whose secrets must never land in metadata as plaintext."],
      settings: {
        defaultTemperature: 0.3,
        secrets: { OPENAI_API_KEY: OPENAI_SECRET },
      },
    };

    let capturedMetadata: Record<string, unknown> | undefined;
    const runtime = {
      agentId: AGENT_ID,
      character,
      updateAgent: async (
        _id: UUID,
        data: { metadata?: Record<string, unknown> },
      ) => {
        capturedMetadata = data.metadata;
        return true;
      },
      createMemory: async () => AGENT_ID,
    } as unknown as IAgentRuntime;

    const service = new ElizaCharacterPersistenceService(runtime);
    const result = await service.persistCharacter({ character });
    expect(result.success).toBe(true);

    const persisted = capturedMetadata?.character as {
      settings?: {
        secrets?: Record<string, string>;
        defaultTemperature?: number;
      };
    };
    const persistedSecret = persisted.settings?.secrets?.OPENAI_API_KEY;

    // No plaintext secret is embedded in the persisted metadata snapshot.
    expect(JSON.stringify(capturedMetadata)).not.toContain(OPENAI_SECRET);
    expect(persistedSecret).toMatch(/^v2:/);
    // Non-secret settings pass through untouched.
    expect(persisted.settings?.defaultTemperature).toBe(0.3);

    // The persisted ciphertext round-trips back to the original plaintext.
    const roundTripped = decryptedCharacter(persisted as Character);
    expect(roundTripped.settings?.secrets?.OPENAI_API_KEY).toBe(OPENAI_SECRET);

    // The caller's character object is never mutated.
    expect(character.settings?.secrets?.OPENAI_API_KEY).toBe(OPENAI_SECRET);
  });
});
