/** Exercises backup capture and local restore over the real host HTTP server and filesystem-backed PGlite, including complete file bytes, admission failures, tamper rejection, size refusal, and storage failure. */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  type AgentBackupCaptureV2Request,
  type AgentBackupPostgresDump,
  parseAgentBackupCaptureV2Frames,
} from "@elizaos/contracts";
import {
  AGENT_BACKUP_CANONICAL_JSON,
  canonicalJsonString,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  type AgentBackupStateData,
  restoreAgentSnapshot,
  restorePostgresRows,
} from "../src/services/agent-backup.ts";

const token = randomUUID();
const media = Buffer.from("complete media payload 🚀\n".repeat(25_000));
let directory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-backup-http-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    PGLITE_DATA_DIR: path.join(directory, ".elizadb"),
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
  fixture = await createTestRuntime({
    // The capture wire contract requires an RFC UUID, not a name-hashed v0 ID.
    characterName: randomUUID(),
    pgliteDir: path.join(directory, ".elizadb"),
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
  for (const child of ["media", "models", "skills/.cache"])
    await mkdir(path.join(directory, child), { recursive: true });
  await writeFile(path.join(directory, "media", "complete.bin"), media);
  await writeFile(path.join(directory, "media", "empty.bin"), "");
  await writeFile(path.join(directory, "notes.txt"), "complete state tail");
  await writeFile(path.join(directory, "vault.json"), "{}");
  await writeFile(path.join(directory, "models", "download.bin"), "cache");
  await writeFile(path.join(directory, "skills/.cache/catalog.json"), "{}");
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

function requestBody(): AgentBackupCaptureV2Request {
  return {
    format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
    schemaVersion: 2,
    operationId: randomUUID(),
    agentId: fixture.runtime.agentId,
    activationGeneration: randomUUID(),
    lifecycleRevision: "1",
    deadlineEpochMs: Date.now() + 120_000,
  };
}

function request(route: string, body?: object, authenticated = true) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

it("captures complete multi-frame files and a real database through both formats", async () => {
  const response = await request("/api/snapshot/v2", requestBody());
  expect(response.status, response.ok ? undefined : await response.text()).toBe(
    200,
  );
  if (!response.body) throw new Error("Capture response has no body");
  const captured = new Map<string, Buffer[]>();
  const kinds: string[] = [];
  for await (const frame of parseAgentBackupCaptureV2Frames(response.body, {
    sha256StreamFactory: () => {
      const hash = createHash("sha256");
      return {
        update: (bytes) => {
          hash.update(bytes);
        },
        digestHex: () => hash.digest("hex"),
      };
    },
  })) {
    kinds.push(frame.header.kind);
    if (frame.header.kind !== "data") continue;
    const key = `${frame.header.componentName}/${frame.header.entry?.path ?? "opaque"}`;
    const chunks = captured.get(key) ?? [];
    chunks.push(Buffer.from(frame.payload));
    captured.set(key, chunks);
  }
  expect(kinds.at(-1)).toBe("capture-end");
  expect(Buffer.concat(captured.get("media/complete.bin") ?? [])).toEqual(
    media,
  );
  expect(captured.has("media/empty.bin")).toBe(true);
  expect(Buffer.concat(captured.get("media/empty.bin") ?? [])).toHaveLength(0);
  expect(
    Buffer.concat(captured.get("database/opaque") ?? []).length,
  ).toBeGreaterThan(0);
  expect(
    Buffer.concat(captured.get("state-files/notes.txt") ?? []).toString(),
  ).toBe("complete state tail");
  expect(captured.has("state-files/models/download.bin")).toBe(false);
  expect(captured.has("state-files/skills/.cache/catalog.json")).toBe(false);
  expect(captured.has("vault/vault.json")).toBe(true);

  const legacy = await request("/api/snapshot");
  expect(legacy.status).toBe(200);
  const snapshot: AgentBackupStateData = await legacy.json();
  const entry = snapshot.manifest.components.media.files.find(
    (file) => file.path === "complete.bin",
  );
  if (!entry) throw new Error("Snapshot omitted the media file");
  expect(Buffer.from(entry.bytesBase64, "base64")).toEqual(media);
  expect(snapshot.manifest.components.database.kind).toBe("pglite-dump");
  entry.bytesBase64 = Buffer.from("tampered").toString("base64");
  await expect(
    restoreAgentSnapshot(fixture.runtime, snapshot),
  ).rejects.toThrow();
  expect(await readFile(path.join(directory, "media", "complete.bin"))).toEqual(
    media,
  );
}, 120_000);

it("rejects unauthenticated, wrong-agent and expired captures before streaming", async () => {
  const unauthorized = await request("/api/snapshot/v2", requestBody(), false);
  expect([401, 403]).toContain(unauthorized.status);
  const wrongAgent = await request("/api/snapshot/v2", {
    ...requestBody(),
    agentId: randomUUID(),
  });
  expect(wrongAgent.status).toBe(409);
  const expired = await request("/api/snapshot/v2", {
    ...requestBody(),
    deadlineEpochMs: Date.now() - 1,
  });
  expect(expired.status, await expired.text()).toBe(408);
});

it("distinguishes size and storage failures, then creates and restores a complete local backup", async () => {
  // A sparse file declares 1.5 GiB without allocating it. The in-memory format
  // refuses it from its stat size, and so does the streamed format that takes
  // over above that ceiling (its limit is the capture-v2 1 GiB plaintext cap),
  // both before reading any bytes.
  const oversized = path.join(directory, "media", "oversized.bin");
  await writeFile(oversized, "");
  await truncate(oversized, 1536 * 1024 * 1024);
  try {
    const refused = await request("/api/backups");
    expect(refused.status).toBe(413);
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: "AGENT_SNAPSHOT_BUDGET_EXCEEDED",
      unit: "bytes",
      retryable: false,
    });
    expect(body.observed as number).toBeGreaterThan(body.limit as number);
    expect(body.limit).toBe(AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes);
    expect(String(body.error)).toMatch(/too large for a local backup/);
    expect(JSON.stringify(body)).not.toContain(directory);
  } finally {
    await rm(oversized, { force: true });
  }

  const backupDirectory = path.join(directory, "backups");
  await writeFile(backupDirectory, "not a directory");
  try {
    const failed = await request("/api/backups");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Backup failed" });
    // The refusal happens at the storage boundary: the blocking file is intact
    // and no partial backup directory was created in its place.
    expect((await stat(backupDirectory)).isFile()).toBe(true);
    expect(await readFile(backupDirectory, "utf8")).toBe("not a directory");
  } finally {
    await rm(backupDirectory, { force: true });
  }

  const created = await request("/api/backups");
  expect(created.status, await created.clone().text()).toBe(200);
  const { backup } = (await created.json()) as {
    backup: { fileName: string; sizeBytes: number };
  };
  const artifact = await readFile(path.join(backupDirectory, backup.fileName));
  expect(artifact.length).toBe(backup.sizeBytes);
  const envelope = JSON.parse(artifact.toString("utf8")) as {
    format: string;
    agentId: string;
    encryption: { algorithm: string; ciphertext: string };
  };
  expect(envelope.format).toBe("elizaos.agent-backup-file");
  expect(envelope.agentId).toBe(fixture.runtime.agentId);
  expect(envelope.encryption.algorithm).toBe("kms-aes-256-gcm");
  expect(envelope.encryption.ciphertext.length).toBeGreaterThan(0);
  // Plaintext state stores file bytes as base64; neither form may appear.
  const artifactText = artifact.toString("utf8");
  expect(artifact.includes(media)).toBe(false);
  expect(
    artifactText.includes(media.subarray(0, 3072).toString("base64")),
  ).toBe(false);
  expect(artifactText.includes("complete state tail")).toBe(false);
  const artifactHash = createHash("sha256").update(artifact).digest("hex");

  const originalName = fixture.runtime.character.name;
  const changedName = `${originalName}-after-backup`;
  expect(
    await fixture.runtime.updateAgent(fixture.runtime.agentId, {
      name: changedName,
    }),
  ).toBe(true);
  expect((await fixture.runtime.getAgent(fixture.runtime.agentId))?.name).toBe(
    changedName,
  );
  await writeFile(path.join(directory, "media", "complete.bin"), "changed");
  await writeFile(path.join(directory, "media", "empty.bin"), "changed");
  await writeFile(path.join(directory, "notes.txt"), "changed");
  // Restore stops the shared runtime and closes its adapter, so this must stay
  // the final scenario that uses `fixture.runtime` or the server.
  const restored = await request("/api/backups/restore", {
    fileName: backup.fileName,
  });
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(await restored.json()).toEqual({
    restored: true,
    requiresRestart: true,
  });
  expect(await readFile(path.join(directory, "media", "complete.bin"))).toEqual(
    media,
  );
  expect(await readFile(path.join(directory, "media", "empty.bin"))).toEqual(
    Buffer.alloc(0),
  );
  expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
    "complete state tail",
  );
  expect(
    createHash("sha256")
      .update(await readFile(path.join(backupDirectory, backup.fileName)))
      .digest("hex"),
  ).toBe(artifactHash);

  const database = new PGlite(fixture.pgliteDir, { extensions: { vector } });
  try {
    const result = await database.query<{ id: string; name: string }>(
      "SELECT id, name FROM agents WHERE id = $1",
      [fixture.runtime.agentId],
    );
    expect(result.rows).toEqual([
      { id: fixture.runtime.agentId, name: originalName },
    ]);
  } finally {
    await database.close();
  }
}, 120_000);

it("rolls back PostgreSQL row restores and preserves other agents over the database protocol", async () => {
  const db = await PGlite.create(path.join(directory, "postgres-rows"));
  const owner = randomUUID();
  const other = randomUUID();
  const tables = [
    {
      name: "memories",
      columns: ["id", "agent_id"],
      rows: [{ id: "restored", agent_id: owner }],
    },
  ];
  const dump: AgentBackupPostgresDump = {
    kind: "postgres-rows",
    tables,
    sha256: createHash("sha256")
      .update(canonicalJsonString(tables, AGENT_BACKUP_CANONICAL_JSON))
      .digest("hex"),
  };
  const restore = async () => {
    const bridge = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
    await bridge.start();
    try {
      await restorePostgresRows(
        `postgresql://postgres@${bridge.getServerConn()}/postgres`,
        owner,
        dump,
      );
    } finally {
      await bridge.stop();
    }
  };
  const original = [
    { id: "old", agent_id: owner },
    { id: "other", agent_id: other },
  ];
  try {
    await db.exec(`
      CREATE TABLE memories (id text PRIMARY KEY, agent_id uuid NOT NULL);
      CREATE TABLE agents (id uuid PRIMARY KEY);
      CREATE TABLE embeddings (memory_id text REFERENCES memories(id));
      CREATE TABLE retained_reference (agent_id uuid REFERENCES agents(id));
      CREATE FUNCTION refuse_embedding_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'embedding delete denied' USING ERRCODE = '42501'; END
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_delete BEFORE DELETE ON embeddings
        FOR EACH ROW EXECUTE FUNCTION refuse_embedding_delete();
    `);
    await db.query("INSERT INTO memories VALUES ('old', $1), ('other', $2)", [
      owner,
      other,
    ]);
    await db.query("INSERT INTO agents VALUES ($1), ($2)", [owner, other]);
    await db.query("INSERT INTO retained_reference VALUES ($1)", [owner]);
    await db.exec("INSERT INTO embeddings VALUES ('old')");
    await expect(restore()).rejects.toMatchObject({
      code: "42501",
      message: "embedding delete denied",
    });
    expect((await db.query("SELECT * FROM memories ORDER BY id")).rows).toEqual(
      original,
    );
    await db.exec("DROP TRIGGER refuse_delete ON embeddings");
    await expect(restore()).rejects.toMatchObject({
      code: "23503",
      table: "retained_reference",
    });
    expect((await db.query("SELECT * FROM memories ORDER BY id")).rows).toEqual(
      original,
    );
    expect((await db.query("SELECT * FROM embeddings")).rows).toEqual([
      { memory_id: "old" },
    ]);
    expect(
      (await db.query("SELECT count(*)::int AS count FROM agents")).rows,
    ).toEqual([{ count: 2 }]);
    await db.exec("DROP TABLE retained_reference, embeddings, agents");
    await restore();
    expect((await db.query("SELECT * FROM memories ORDER BY id")).rows).toEqual(
      [
        { id: "other", agent_id: other },
        { id: "restored", agent_id: owner },
      ],
    );
  } finally {
    await db.close();
  }
}, 120_000);
