/** Sends document uploads and edits larger than the agent server's 1 MiB default body cap through the production HTTP server and real PGlite persistence; synthetic text only, no PDF/model acceptance. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelType, type UUID } from "@elizaos/core";
import { installHttpPluginLifecycle } from "@elizaos/host/protocol";

import { createDocumentsPlugin } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { knowledgePlugin } from "../../../plugins/plugin-knowledge/src/plugin.ts";
import { startApiServer } from "../src/api/server.ts";

const owner = "f4360000-0000-4000-8000-000000000001" as UUID;
const room = "f4360000-0000-4000-8000-000000000002" as UUID;
const world = "f4360000-0000-4000-8000-000000000003" as UUID;
const token = randomUUID();
const documentBudgetBytes = 32 * 1_048_576;
let stateDirectory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "eliza-upload-limit-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: stateDirectory,
    ELIZA_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    AGENT_SERVER_SHARED_SECRET: randomBytes(32).toString("hex"),
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({
    characterName: "UploadLimitAcceptance",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner, LOAD_DOCS_ON_STARTUP: false },
    plugins: [createDocumentsPlugin(), knowledgePlugin],
  });
  await fixture.runtime.ensureConnection({
    entityId: owner,
    roomId: room,
    worldId: world,
    worldName: "Synthetic upload limit",
    userName: "Owner",
    name: "Owner",
    source: "test",
    type: ChannelType.DM,
  });
  installHttpPluginLifecycle(fixture.runtime);
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
  if (stateDirectory)
    await rm(stateDirectory, { recursive: true, force: true });
}, 120_000);

function request(method: string, pathname: string, body: object) {
  return fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

function text(bytes: number, label: string) {
  const line = `${label}: vendor totals confirmed for the quarter.\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

function readOwnerDocument(documentId: UUID) {
  return fixture.runtime.adapter.getDocument({
    agentId: fixture.runtime.agentId,
    documentId,
    requesterEntityId: owner,
    requesterRole: "OWNER",
    requesterRoomIds: [],
  });
}

it("accepts uploads and edits above 1 MiB within the 32 MiB document budget", async () => {
  const content = text(2_000_000, "Upload");
  const upload = await request("POST", "/api/documents", {
    content,
    filename: "vendor-notes.txt",
    contentType: "text/plain",
    scope: "owner-private",
  });
  expect(upload.status).toBe(200);
  const uploaded = await upload.json();
  expect(
    (await readOwnerDocument(uploaded.documentId))?.metadata,
  ).toMatchObject({ sourceByteLength: content.length });

  const edited = text(2_500_000, "Edit");
  const edit = await request("PATCH", `/api/documents/${uploaded.documentId}`, {
    content: edited,
  });
  expect(edit.status).toBe(200);
  expect(
    (await readOwnerDocument(uploaded.documentId))?.metadata,
  ).toMatchObject({ sourceByteLength: edited.length });

  const bulk = await request("POST", "/api/documents/bulk", {
    scope: "owner-private",
    documents: ["first", "second"].map((name) => ({
      content: text(1_200_000, name),
      filename: `${name}.txt`,
      contentType: "text/plain",
    })),
  });
  expect(bulk.status).toBe(200);
  expect(await bulk.json()).toMatchObject({ ok: true, successCount: 2 });
}, 120_000);

it("still refuses an upload body over the 32 MiB document budget", async () => {
  const response = await request("POST", "/api/documents", {
    content: "x".repeat(documentBudgetBytes),
    filename: "oversized.txt",
    contentType: "text/plain",
    scope: "owner-private",
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    maxBytes: documentBudgetBytes,
  });
}, 120_000);
