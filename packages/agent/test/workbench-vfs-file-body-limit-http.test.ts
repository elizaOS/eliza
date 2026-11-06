/**
 * Real agent HTTP server and the real Workbench VFS: a file the VFS accepts
 * under its 10 MiB per-file limit must survive the JSON body transport.
 * Synthetic text and bytes only.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";

const token = randomUUID();
let directory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

function fileUrl(projectId: string, filePath: string): string {
  return `http://127.0.0.1:${server.port}/api/workbench/vfs/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`;
}

function putFile(projectId: string, body: Record<string, unknown>) {
  return fetch(fileUrl(projectId, String(body.path)), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function readFile(
  projectId: string,
  filePath: string,
  options: { encoding?: string } = {},
) {
  const suffix = options.encoding
    ? `&encoding=${encodeURIComponent(options.encoding)}`
    : "";
  return fetch(`${fileUrl(projectId, filePath)}${suffix}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-vfs-body-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ELIZA_PLUGIN_SET: "lean-chat",
  }))
    vi.stubEnv(key, value);
  for (const key of ["POSTGRES_URL", "DATABASE_URL", "ELIZA_CLOUD_PROVISIONED"])
    vi.stubEnv(key, undefined);
  fixture = await createTestRuntime({
    characterName: "VfsBodyLimit",
    pgliteDir: path.join(directory, "db"),
    removePgliteDirOnCleanup: false,
    settings: { LOAD_DOCS_ON_STARTUP: false },
  });
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

it("stores a 2 MiB text file the VFS accepts", async () => {
  const project = randomUUID();
  const content = "vendor totals confirmed for the quarter.\n".repeat(50_000);

  const written = await putFile(project, {
    path: "quarter.txt",
    content,
    encoding: "utf-8",
  });
  expect(written.status).toBe(200);

  const read = await readFile(project, "quarter.txt");
  expect(read.status).toBe(200);
  expect(((await read.json()) as { content: string }).content).toBe(content);
}, 120_000);

it("stores a 2 MiB binary file the VFS accepts", async () => {
  const project = randomUUID();
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const content = bytes.toString("base64");

  const written = await putFile(project, {
    path: "bundle.bin",
    content,
    encoding: "base64",
  });
  expect(written.status).toBe(200);

  const read = await readFile(project, "bundle.bin", { encoding: "base64" });
  expect(read.status).toBe(200);
  expect(
    Buffer.from(((await read.json()) as { content: string }).content, "base64")
      .length,
  ).toBe(bytes.length);
}, 120_000);
