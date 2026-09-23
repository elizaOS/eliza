/** Verifies pendant repository selection and optimistic revisions against real PGlite migrations. */
import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { expect, it } from "vitest";
import {
  createPendantSessionRepository,
  PendantSessionRevisionConflictError,
  type StoredPendantSessionDocument,
} from "./repository.ts";
import { pendantSessionSchema } from "./schema.ts";

it("preserves PostgreSQL session creation, revision conflicts, lease retention and deletion", async () => {
  const agentId = randomUUID() as UUID;
  const adapter = createDatabaseAdapter({ dataDir: "memory://" }, agentId);
  try {
    await adapter.initialize();
    if (!adapter.runPluginMigrations)
      throw new Error("PGlite fixture requires plugin migrations");
    await adapter.runPluginMigrations([
      { name: "pendant-test", schema: pendantSessionSchema },
    ]);
    const repository = createPendantSessionRepository({ agentId, adapter });
    const stored: StoredPendantSessionDocument = {
      schemaVersion: 1,
      session: {
        id: "session",
        ownerId: "owner",
        agentId,
        startedAt: "2026-09-23T12:00:00.000Z",
        endedAt: null,
        state: "active",
        processingLocation: "cloud",
        captureLease: {
          holder: "device",
          tokenDigest: "synthetic-digest",
          expiresAt: "2026-09-23T13:00:00.000Z",
        },
        revision: 0,
      },
      segments: [],
      insightRefs: [],
    };
    const scope = { ownerId: "owner", agentId, sessionId: "session" };
    expect(await repository.create(stored)).toBe(true);
    expect(await repository.create(stored)).toBe(false);
    expect(await repository.load(scope)).toEqual(stored);
    stored.session.revision = 1;
    await repository.saveSession(stored);
    await expect(repository.saveSession(stored)).rejects.toBeInstanceOf(
      PendantSessionRevisionConflictError,
    );
    expect(await repository.load(scope)).toEqual(stored);
    expect(await repository.load({ ...scope, ownerId: "other" })).toBeNull();
    await repository.delete(scope);
    expect(await repository.load(scope)).toBeNull();
  } finally {
    await adapter.close();
  }
}, 120_000);
