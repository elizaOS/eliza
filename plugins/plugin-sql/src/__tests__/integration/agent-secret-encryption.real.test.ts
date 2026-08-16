/**
 * Real-database proof that the shared SQL adapter is the canonical at-rest
 * encryption boundary for agent secret settings. Every assertion runs against a
 * live PGlite (or Postgres) adapter — createAgent/updateAgent encrypt eligible
 * secret values before write, mapAgentRow decrypts them on read, and the RAW
 * stored JSON is inspected directly to prove no configured plaintext secret is
 * persisted. Covers create, update, restart/reload, idempotency, migration on
 * write of pre-existing plaintext, missing-settings, caller-input non-mutation,
 * and wrong-salt fail-closed behavior.
 */
import { type Agent, clearSaltCache, type UUID } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { agentTable } from "../../schema";
import { createIsolatedTestDatabase } from "../test-helpers";

const TEST_SALT = "agent-secret-encryption-test-salt";
const OPENAI_SECRET = "sk-openai-do-not-leak-abcdef1234567890";
const ANTHROPIC_SECRET = "sk-anthropic-do-not-leak-0987654321";

const agentDefaults = {
  templates: {},
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  style: { all: [], chat: [], post: [] },
};

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    ...agentDefaults,
    id: uuidv4() as UUID,
    name: "Secret Boundary Agent",
    username: "secret_boundary",
    bio: ["An agent used to prove settings-secret encryption at rest."],
    system: "You are a helpful assistant.",
    settings: {},
    secrets: {},
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as Agent;
}

describe("Agent secret settings encryption at the SQL persistence boundary", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let previousSalt: string | undefined;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("agent-secret-encryption");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(() => {
    previousSalt = process.env.SECRET_SALT;
    process.env.SECRET_SALT = TEST_SALT;
    clearSaltCache();
  });

  afterEach(() => {
    if (previousSalt === undefined) delete process.env.SECRET_SALT;
    else process.env.SECRET_SALT = previousSalt;
    clearSaltCache();
  });

  const readRawSettings = async (id: UUID): Promise<Record<string, unknown>> => {
    const db = adapter.getDatabase() as unknown as {
      select: () => {
        from: (table: typeof agentTable) => {
          where: (cond: unknown) => Promise<Array<{ settings: unknown; secrets: unknown }>>;
        };
      };
    };
    const rows = await db.select().from(agentTable).where(eq(agentTable.id, id));
    return (rows[0] ?? {}) as Record<string, unknown>;
  };

  it("createAgent stores no plaintext secret at rest and getAgent resolves plaintext", async () => {
    const input = makeAgent({
      settings: {
        defaultTemperature: 0.4,
        secrets: { OPENAI_API_KEY: OPENAI_SECRET, ANTHROPIC_API_KEY: ANTHROPIC_SECRET },
      },
    });

    const created = await adapter.createAgent(input);
    expect(created).toBe(true);

    // RAW stored JSON must not contain any configured plaintext secret value.
    const raw = await readRawSettings(input.id as UUID);
    const rawJson = JSON.stringify(raw);
    expect(rawJson).not.toContain(OPENAI_SECRET);
    expect(rawJson).not.toContain(ANTHROPIC_SECRET);
    const rawSettings = raw.settings as {
      secrets?: Record<string, string>;
      defaultTemperature?: number;
    };
    expect(rawSettings.secrets?.OPENAI_API_KEY).toMatch(/^v2:/);
    expect(rawSettings.secrets?.ANTHROPIC_API_KEY).toMatch(/^v2:/);
    // Non-secret settings stay untouched.
    expect(rawSettings.defaultTemperature).toBe(0.4);

    // Runtime read boundary resolves the original plaintext.
    const loaded = await adapter.getAgent(input.id as UUID);
    expect(loaded?.settings?.secrets?.OPENAI_API_KEY).toBe(OPENAI_SECRET);
    expect(loaded?.settings?.secrets?.ANTHROPIC_API_KEY).toBe(ANTHROPIC_SECRET);
  });

  it("does not mutate the caller's input object", async () => {
    const secretsRef = { OPENAI_API_KEY: OPENAI_SECRET };
    const input = makeAgent({ settings: { secrets: secretsRef } });

    await adapter.createAgent(input);

    // The exact object the caller passed must still hold plaintext.
    expect(secretsRef.OPENAI_API_KEY).toBe(OPENAI_SECRET);
    expect(input.settings?.secrets?.OPENAI_API_KEY).toBe(OPENAI_SECRET);
  });

  it("updateAgent encrypts newly written secrets and getAgent resolves them", async () => {
    const input = makeAgent({ settings: { secrets: {} } });
    await adapter.createAgent(input);

    const ok = await adapter.updateAgent(input.id as UUID, {
      settings: { secrets: { OPENAI_API_KEY: OPENAI_SECRET } },
    });
    expect(ok).toBe(true);

    const raw = await readRawSettings(input.id as UUID);
    expect(JSON.stringify(raw)).not.toContain(OPENAI_SECRET);
    const rawSettings = raw.settings as { secrets?: Record<string, string> };
    expect(rawSettings.secrets?.OPENAI_API_KEY).toMatch(/^v2:/);

    const loaded = await adapter.getAgent(input.id as UUID);
    expect(loaded?.settings?.secrets?.OPENAI_API_KEY).toBe(OPENAI_SECRET);
  });

  it("is idempotent — an already-encrypted value is not double-encrypted", async () => {
    const input = makeAgent({ settings: { secrets: { OPENAI_API_KEY: OPENAI_SECRET } } });
    await adapter.createAgent(input);

    // Grab the stored ciphertext and feed it straight back through updateAgent.
    const firstRaw = await readRawSettings(input.id as UUID);
    const cipher = (firstRaw.settings as { secrets: Record<string, string> }).secrets
      .OPENAI_API_KEY;
    expect(cipher).toMatch(/^v2:/);

    const ok = await adapter.updateAgent(input.id as UUID, {
      settings: { secrets: { OPENAI_API_KEY: cipher } },
    });
    expect(ok).toBe(true);

    const secondRaw = await readRawSettings(input.id as UUID);
    const stored = (secondRaw.settings as { secrets: Record<string, string> }).secrets
      .OPENAI_API_KEY;
    // Still a single v2 envelope (four colon-delimited parts), not a nested one.
    expect(stored.split(":")).toHaveLength(4);
    const loaded = await adapter.getAgent(input.id as UUID);
    expect(loaded?.settings?.secrets?.OPENAI_API_KEY).toBe(OPENAI_SECRET);
  });

  it("migrates pre-existing plaintext-at-rest to ciphertext on the next write", async () => {
    const id = uuidv4() as UUID;
    // Simulate a legacy row written before encryption existed by inserting
    // plaintext directly, bypassing the adapter's encrypt-on-write boundary.
    const db = adapter.getDatabase() as unknown as {
      insert: (table: typeof agentTable) => {
        values: (v: Record<string, unknown>) => Promise<unknown>;
      };
    };
    await db.insert(agentTable).values({
      id,
      name: "Legacy Plaintext Agent",
      bio: ["legacy"],
      settings: { secrets: { OPENAI_API_KEY: OPENAI_SECRET } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Plaintext read still works (decrypt passes non-ciphertext through).
    const beforeMigration = await adapter.getAgent(id);
    expect(beforeMigration?.settings?.secrets?.OPENAI_API_KEY).toBe(OPENAI_SECRET);

    // Any subsequent write encrypts the legacy plaintext.
    await adapter.updateAgent(id, { settings: { secrets: { OPENAI_API_KEY: OPENAI_SECRET } } });
    const raw = await readRawSettings(id);
    expect(JSON.stringify(raw)).not.toContain(OPENAI_SECRET);
    expect((raw.settings as { secrets: Record<string, string> }).secrets.OPENAI_API_KEY).toMatch(
      /^v2:/
    );
  });

  it("handles agents with no settings/secrets without error", async () => {
    const input = makeAgent({ settings: {}, secrets: {} });
    const created = await adapter.createAgent(input);
    expect(created).toBe(true);
    const loaded = await adapter.getAgent(input.id as UUID);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("Secret Boundary Agent");
  });

  it("fails closed on read when the salt is wrong instead of exposing ciphertext", async () => {
    const input = makeAgent({ settings: { secrets: { OPENAI_API_KEY: OPENAI_SECRET } } });
    await adapter.createAgent(input);

    // Rotate to the wrong salt: decryption must throw, never return ciphertext
    // as a usable value.
    process.env.SECRET_SALT = "a-different-wrong-salt";
    clearSaltCache();
    await expect(adapter.getAgent(input.id as UUID)).rejects.toThrow(
      /Failed to decrypt secret setting/
    );
  });
});
