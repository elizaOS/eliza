/** Exercises both backup formats over the real host HTTP server and filesystem-backed PGlite, including complete file bytes, empty files, admission failures and tamper rejection. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  type AgentBackupCaptureV2Request,
  parseAgentBackupCaptureV2Frames,
} from "@elizaos/shared";
import { createTestRuntime } from "@elizaos/testing/pglite-runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  type AgentBackupStateData,
  restoreAgentSnapshot,
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
