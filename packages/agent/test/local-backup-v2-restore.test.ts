/** Round-trips an agent above the 128 MiB in-memory backup ceiling through the streamed, encrypted local format over the real HTTP host and filesystem PGlite, and proves corrupted archives and failed swaps leave live data untouched. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MAX_RESTORABLE_AGENT_BACKUP_BYTES } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import { restoreLocalAgentBackup } from "../src/services/agent-backup.ts";

const MIB = 1024 * 1024;
const LARGE_MIB = 144;
const token = randomUUID();
const canary = `local-v2-plaintext-canary-${randomUUID()}`;
const pattern = randomBytes(64 * 1024);
let directory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let largeSha256: string;
let v2FileName: string;

interface RawPglite {
  exec(query: string): Promise<unknown>;
  query<T>(query: string): Promise<{ rows: T[] }>;
}

beforeAll(async () => {
  expect(LARGE_MIB * MIB).toBeGreaterThan(MAX_RESTORABLE_AGENT_BACKUP_BYTES);
  directory = await mkdtemp(path.join(tmpdir(), "agent-backup-v2-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
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
    characterName: randomUUID(),
    pgliteDir: path.join(directory, ".elizadb"),
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
  await mkdir(path.join(directory, "media"), { recursive: true });
  await mkdir(path.join(directory, "audit"), { recursive: true });
  await writeFile(path.join(directory, "media", "pattern.bin"), pattern);
  await writeFile(path.join(directory, "notes.txt"), canary);
  await writeFile(path.join(directory, "vault.json"), '{"v":"original"}');
  await writeFile(path.join(directory, "audit", "vault.jsonl"), "{}\n");
  await rawDatabase().exec(
    "CREATE TABLE backup_v2_marker (label text); INSERT INTO backup_v2_marker VALUES ('before');",
  );
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
}, 180_000);

afterAll(async () => {
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (directory) {
    await chmod(path.join(directory, "locked"), 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

function rawDatabase(): RawPglite {
  return (
    fixture.runtime.adapter as unknown as { getRawConnection(): RawPglite }
  ).getRawConnection();
}

async function markerLabels(): Promise<string[]> {
  const database = await PGlite.create({
    dataDir: path.join(directory, ".elizadb"),
  });
  try {
    const result = await database.query<{ label: string }>(
      "SELECT label FROM backup_v2_marker ORDER BY label",
    );
    return result.rows.map((row) => row.label);
  } finally {
    await database.close();
  }
}

function api(route: string, method: "GET" | "POST", body?: object) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileContains(
  filePath: string,
  needle: string,
): Promise<boolean> {
  const bytes = Buffer.from(needle);
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    const window = Buffer.concat([carry, chunk as Buffer]);
    if (window.includes(bytes)) return true;
    carry = window.subarray(Math.max(0, window.length - bytes.length));
  }
  return false;
}

async function backupWorkEntries(): Promise<string[]> {
  return (await readdir(path.join(directory, "backups"))).filter(
    (name) =>
      name.startsWith(".restore-") ||
      name.startsWith(".capture-") ||
      name.endsWith(".partial"),
  );
}

it("keeps small agents on v1 and streams an over-ceiling agent to an encrypted v2 archive", async () => {
  const small = await api("/api/backups", "POST");
  expect(small.status, await small.clone().text()).toBe(200);
  const { backup: v1 } = (await small.json()) as {
    backup: { fileName: string };
  };
  expect(v1.fileName.endsWith(".agent-backup.json")).toBe(true);

  const hash = createHash("sha256");
  const handle = await open(path.join(directory, "media", "large.bin"), "w");
  try {
    const block = randomBytes(MIB);
    for (let index = 0; index < LARGE_MIB; index += 1) {
      block.writeUInt32BE(index, 0);
      hash.update(block);
      await handle.write(block);
    }
  } finally {
    await handle.close();
  }
  largeSha256 = hash.digest("hex");

  const created = await api("/api/backups", "POST");
  expect(created.status, await created.clone().text()).toBe(200);
  const { backup } = (await created.json()) as {
    backup: { fileName: string; sizeBytes: number; stateSha256: string };
  };
  expect(backup.fileName.endsWith(".agent-backup-v2")).toBe(true);
  expect(backup.sizeBytes).toBeGreaterThan(LARGE_MIB * MIB);
  expect(backup.stateSha256).toMatch(/^[a-f0-9]{64}$/);
  v2FileName = backup.fileName;

  const listed = await api("/api/backups", "GET");
  expect(listed.status).toBe(200);
  const { backups } = (await listed.json()) as {
    backups: Array<{ fileName: string; stateSha256: string }>;
  };
  expect(backups.map((entry) => entry.fileName)).toEqual([
    v2FileName,
    v1.fileName,
  ]);
  expect(backups[0]?.stateSha256).toBe(backup.stateSha256);

  const archivePath = path.join(directory, "backups", v2FileName);
  const magic = Buffer.alloc(8);
  const archive = await open(archivePath, "r");
  try {
    await archive.read(magic, 0, 8, 0);
  } finally {
    await archive.close();
  }
  expect(magic.toString("ascii")).toBe("ELZLBK02");
  expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
  expect(await fileContains(archivePath, canary)).toBe(false);
  expect(await backupWorkEntries()).toEqual([]);
}, 600_000);

it("rejects a corrupted archive before touching the live agent", async () => {
  await rawDatabase().exec("INSERT INTO backup_v2_marker VALUES ('after');");
  await writeFile(path.join(directory, "notes.txt"), "changed after backup");
  await writeFile(path.join(directory, "media", "new.bin"), "new media");

  const corruptName = v2FileName.replace(
    /\.agent-backup-v2$/,
    "-corrupt.agent-backup-v2",
  );
  const corruptPath = path.join(directory, "backups", corruptName);
  await copyFile(path.join(directory, "backups", v2FileName), corruptPath);
  const handle = await open(corruptPath, "r+");
  try {
    const { size } = await handle.stat();
    const offset = Math.floor(size / 2);
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, offset);
    byte[0] = (byte[0] ?? 0) ^ 0xff;
    await handle.write(byte, 0, 1, offset);
  } finally {
    await handle.close();
  }
  try {
    const refused = await api("/api/backups/restore", "POST", {
      fileName: corruptName,
    });
    expect(refused.status).toBe(500);
  } finally {
    await rm(corruptPath, { force: true });
  }

  expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
    "changed after backup",
  );
  expect(await readFile(path.join(directory, "media", "new.bin"), "utf8")).toBe(
    "new media",
  );
  // The runtime was never stopped: its own connection still answers.
  const rows = await rawDatabase().query<{ label: string }>(
    "SELECT label FROM backup_v2_marker ORDER BY label",
  );
  expect(rows.rows.map((row) => row.label)).toEqual(["after", "before"]);
  expect(await backupWorkEntries()).toEqual([]);
}, 600_000);

it.skipIf(process.getuid?.() === 0)(
  "rolls every swapped target back when a later swap step fails",
  async () => {
    // Renaming a file out of a read-only directory fails after the database
    // and media directories have already been swapped in.
    const locked = path.join(directory, "locked");
    await mkdir(locked, { recursive: true });
    await writeFile(path.join(locked, "keep.txt"), "live only");
    await chmod(locked, 0o500);
    try {
      await expect(
        restoreLocalAgentBackup(fixture.runtime, v2FileName),
      ).rejects.toMatchObject({ code: "AGENT_BACKUP_V2_RESTORE_ROLLED_BACK" });
    } finally {
      await chmod(locked, 0o700);
    }
    expect(
      await readFile(path.join(directory, "media", "new.bin"), "utf8"),
    ).toBe("new media");
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
      "changed after backup",
    );
    expect(await readFile(path.join(locked, "keep.txt"), "utf8")).toBe(
      "live only",
    );
    expect(await markerLabels()).toEqual(["after", "before"]);
    expect(await backupWorkEntries()).toEqual([]);
  },
  600_000,
);

it("restores the streamed archive over HTTP with verified bytes", async () => {
  const restored = await api("/api/backups/restore", "POST", {
    fileName: v2FileName,
  });
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(await restored.json()).toEqual({
    restored: true,
    requiresRestart: true,
  });

  expect(await sha256File(path.join(directory, "media", "large.bin"))).toBe(
    largeSha256,
  );
  expect(await readFile(path.join(directory, "media", "pattern.bin"))).toEqual(
    pattern,
  );
  expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
    canary,
  );
  expect(await readFile(path.join(directory, "vault.json"), "utf8")).toBe(
    '{"v":"original"}',
  );
  await expect(
    stat(path.join(directory, "media", "new.bin")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    stat(path.join(directory, "locked", "keep.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await markerLabels()).toEqual(["before"]);
  expect(await backupWorkEntries()).toEqual([]);
}, 600_000);
