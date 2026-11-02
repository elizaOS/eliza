/** A backup file set is hashed in the order its files are stored, so that
 * order must be the locale-independent unsigned UTF-8 byte order the
 * contracts layer pins for file-set paths — not the host locale's
 * collation, which orders the same names differently on different hosts
 * (and never matches the pinned order for mixed-case names). */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createAgentSnapshot } from "../src/services/agent-backup.ts";

const FILES = ["aa-report.pdf", "b-photo.png", "Zebra.txt", "apple.txt"];
// Unsigned UTF-8 byte order: "Z" (0x5a) sorts before lowercase letters,
// and "aa…" sorts before "ap…" byte-wise in every locale.
const BYTE_ORDER = ["Zebra.txt", "aa-report.pdf", "apple.txt", "b-photo.png"];

let directory: string;
let runtime: Awaited<ReturnType<typeof createTestRuntime>>;
let config: ElizaConfig;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agent-backup-order-"));
  const stateDir = path.join(directory, "state");
  const pgliteDir = path.join(directory, ".elizadb");
  const mediaDir = path.join(stateDir, "media");
  await mkdir(mediaDir, { recursive: true });
  for (const name of FILES)
    await writeFile(path.join(mediaDir, name), `content of ${name}`);
  await writeFile(path.join(stateDir, "vault.json"), "{}");
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: stateDir,
    ELIZA_CONFIG_PATH: path.join(stateDir, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(stateDir, "eliza.json"),
    PGLITE_DATA_DIR: pgliteDir,
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_DATABASE_PROVIDER"])
    vi.stubEnv(key, undefined);
  config = {
    agents: { defaults: { workspace: stateDir } },
  } as ElizaConfig;
  runtime = await createTestRuntime({
    characterName: "Backup file-set order agent",
    pgliteDir,
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await runtime?.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("stores and hashes the media file set in unsigned UTF-8 path order", async () => {
  const snapshot = await createAgentSnapshot(runtime.runtime, config);
  const media = snapshot.manifest.components.media;
  expect(media.files.map((file) => file.path)).toEqual(BYTE_ORDER);
  const hashInput = BYTE_ORDER.map((name) => {
    const bytes = Buffer.from(`content of ${name}`);
    return {
      path: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  });
  expect(media.sha256).toBe(
    createHash("sha256").update(JSON.stringify(hashInput)).digest("hex"),
  );
}, 120_000);
