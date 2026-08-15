/**
 * Exercises Discord connection optimistic concurrency against real PGlite so
 * stale editor snapshots cannot replace newer access metadata or credentials.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.SECRETS_MASTER_KEY ||= "11".repeat(32);

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { discordConnections } from "../schemas/discord-connections";
import { organizations } from "../schemas/organizations";
import { userCharacters } from "../schemas/user-characters";
import { users } from "../schemas/users";
import { discordConnectionsRepository } from "./discord-connections";

const PGLITE_TIMEOUT = 60_000;
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const INITIAL_UPDATED_AT = new Date("2026-08-15T09:00:00.000Z");
let pgliteReady = true;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const { apply } = await pushSchema(
      { organizations, users, userCharacters, discordConnections } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[discord-connections-metadata-conflict.integration.test] PGlite schema setup failed.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(discordConnections);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Discord metadata test",
    slug: "discord-metadata-test",
  });
  await dbWrite.insert(discordConnections).values({
    id: CONNECTION_ID,
    organization_id: ORGANIZATION_ID,
    application_id: "discord-app",
    bot_token_encrypted: "original-ciphertext",
    encrypted_dek: "original-dek",
    token_nonce: "original-nonce",
    token_auth_tag: "original-tag",
    encryption_key_id: "original-key",
    metadata: {
      responseMode: "keyword",
      keywords: ["support"],
      enabledChannels: ["channel-allow"],
    },
    updated_at: INITIAL_UPDATED_AT,
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("discordConnectionsRepository.updateConfiguration", () => {
  test("heartbeat and stats do not invalidate a configuration edit", async () => {
    const initial = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(initial).not.toBeNull();
    if (!initial) throw new Error("seeded Discord connection is required");
    const initialRevision = initial.edit_version;
    expect(initialRevision).toBe("0");

    await discordConnectionsRepository.updateHeartbeat(CONNECTION_ID);
    await discordConnectionsRepository.updateStats(CONNECTION_ID, {
      guildCount: 4,
      eventsReceived: 12,
      eventsRouted: 9,
    });

    const afterTelemetry = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(afterTelemetry?.edit_version).toBe(initial.edit_version);

    const updated = await discordConnectionsRepository.updateConfiguration(
      CONNECTION_ID,
      { metadata: { responseMode: "mention" } },
      initialRevision,
    );
    expect(updated?.edit_version).toBe("1");
  });

  test("a legacy versionless update remains atomic and advances the revision", async () => {
    const updated = await discordConnectionsRepository.updateConfiguration(CONNECTION_ID, {
      metadata: {
        responseMode: "mention",
        keywords: ["support"],
        enabledChannels: ["channel-allow"],
      },
    });

    expect(updated?.edit_version).toBe("1");
    expect(updated?.metadata).toEqual({
      responseMode: "mention",
      keywords: ["support"],
      enabledChannels: ["channel-allow"],
    });
  });

  test("a stale metadata and token update writes nothing", async () => {
    const initial = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(initial).not.toBeNull();
    if (!initial) throw new Error("seeded Discord connection is required");
    expect(initial.edit_version).toMatch(/^\d+$/);
    const initialRevision = initial.edit_version;
    const current = await discordConnectionsRepository.updateConfiguration(
      CONNECTION_ID,
      {
        metadata: {
          responseMode: "keyword",
          keywords: ["support"],
          enabledChannels: ["channel-allow"],
          disabledChannels: ["channel-deny"],
        },
      },
      initialRevision,
    );
    expect(current).not.toBeNull();

    const stale = await discordConnectionsRepository.updateConfiguration(
      CONNECTION_ID,
      {
        metadata: {
          responseMode: "always",
          ownerDiscordUserId: "333333333333333",
        },
        assigned_pod: null,
        status: "pending",
      },
      initialRevision,
      "replacement-token",
    );
    expect(stale).toBeNull();

    const stored = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(stored?.edit_version).not.toBe(initial.edit_version);
    expect(stored?.metadata).toEqual({
      responseMode: "keyword",
      keywords: ["support"],
      enabledChannels: ["channel-allow"],
      disabledChannels: ["channel-deny"],
    });
    expect(stored?.bot_token_encrypted).toBe("original-ciphertext");
  });

  test("concurrent writers publish exactly one complete snapshot", async () => {
    const initial = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(initial).not.toBeNull();
    if (!initial) throw new Error("seeded Discord connection is required");
    const initialRevision = initial.edit_version;
    const [first, second] = await Promise.all([
      discordConnectionsRepository.updateConfiguration(
        CONNECTION_ID,
        { metadata: { responseMode: "mention" } },
        initialRevision,
      ),
      discordConnectionsRepository.updateConfiguration(
        CONNECTION_ID,
        { metadata: { responseMode: "always" } },
        initialRevision,
      ),
    ]);

    expect([first, second].filter((row) => row !== null)).toHaveLength(1);
    expect([first, second].filter((row) => row === null)).toHaveLength(1);
    const stored = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(stored).not.toBeNull();
    const responseMode = stored?.metadata?.responseMode;
    expect(responseMode).toBeDefined();
    if (!responseMode) throw new Error("stored metadata responseMode is required");
    expect(["mention", "always"]).toContain(responseMode);
  });

  test("token rotation and deactivation advance the configuration revision", async () => {
    const initial = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(initial?.edit_version).toBe("0");

    await discordConnectionsRepository.updateBotToken(CONNECTION_ID, "replacement-token");
    const afterToken = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(afterToken?.edit_version).toBe("1");
    expect(afterToken?.bot_token_encrypted).not.toBe("original-ciphertext");

    const stale = await discordConnectionsRepository.updateConfiguration(
      CONNECTION_ID,
      { metadata: { responseMode: "always" } },
      "0",
    );
    expect(stale).toBeNull();

    await discordConnectionsRepository.deactivate(CONNECTION_ID);
    const afterDeactivate = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(afterDeactivate?.edit_version).toBe("2");
    expect(afterDeactivate?.is_active).toBe(false);
  });

  test("advances atomically beyond the PostgreSQL bigint ceiling", async () => {
    await dbWrite
      .update(discordConnections)
      .set({ configuration_revision: "9223372036854775807" })
      .where(eq(discordConnections.id, CONNECTION_ID));

    const versioned = await discordConnectionsRepository.updateConfiguration(
      CONNECTION_ID,
      { metadata: { responseMode: "mention" } },
      "9223372036854775807",
    );
    expect(versioned?.edit_version).toBe("9223372036854775808");

    const versionless = await discordConnectionsRepository.updateConfiguration(CONNECTION_ID, {
      metadata: { responseMode: "always" },
    });
    expect(versionless?.edit_version).toBe("9223372036854775809");
  });

  test("treats an oversized opaque revision as stale without parsing it as numeric", async () => {
    const oversizedRevision = "1".repeat(131_073);

    const stale = await discordConnectionsRepository.updateConfiguration(
      CONNECTION_ID,
      { metadata: { responseMode: "mention" } },
      oversizedRevision,
    );

    expect(stale).toBeNull();
    const stored = await discordConnectionsRepository.findById(CONNECTION_ID);
    expect(stored?.edit_version).toBe("0");
    expect(stored?.metadata?.responseMode).toBe("keyword");
  });
});
