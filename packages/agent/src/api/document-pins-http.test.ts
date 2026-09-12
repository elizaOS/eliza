/** Exercises production pin HTTP routes and real PGlite persistence with an isolated owner token; synthetic document seeding excludes upload/model acceptance. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChannelType,
  type DocumentMemoryMetadata,
  MemoryType,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { documentsPlugin } from "../../../../plugins/plugin-documents/src/plugin.ts";
import { startApiServer } from "./server.ts";

const owner = "f4350000-0000-4000-8000-000000000001" as UUID;
const room = "f4350000-0000-4000-8000-000000000002" as UUID;
const world = "f4350000-0000-4000-8000-000000000003" as UUID;
const documentId = "f4350000-0000-4000-8000-000000000004" as UUID;
const token = randomUUID();
const gatewayToken = randomBytes(32).toString("hex");
let stateDirectory: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeAll(async () => {
  stateDirectory = await mkdtemp(path.join(tmpdir(), "eliza-pin-http-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: stateDirectory,
    ELIZA_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(stateDirectory, "eliza.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    AGENT_SERVER_SHARED_SECRET: gatewayToken,
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({
    characterName: "PinHttpAcceptance",
    settings: { ELIZA_ADMIN_ENTITY_ID: owner, LOAD_DOCS_ON_STARTUP: false },
    plugins: [documentsPlugin],
  });
  await fixture.runtime.ensureConnection({
    entityId: owner,
    roomId: room,
    worldId: world,
    worldName: "Synthetic pin HTTP",
    userName: "Owner",
    name: "Owner",
    source: "test",
    type: ChannelType.DM,
  });
  const metadata: DocumentMemoryMetadata = {
    type: MemoryType.DOCUMENT,
    scope: "owner-private",
    documentId,
    documentRevision: 0,
    addedBy: owner,
    addedByRole: "OWNER",
    addedFrom: "upload",
    source: "test",
    title: "Synthetic agreement",
    filename: "agreement.txt",
    originalFilename: "agreement.txt",
    fileExt: "txt",
    fileType: "text/plain",
    contentType: "text/plain",
    fileSize: Buffer.byteLength(
      "Synthetic agreement reference. Final line preserved.",
    ),
    textBacked: true,
    addedAt: 1_000,
    timestamp: 1_000,
  };
  await fixture.runtime.createMemories([
    {
      tableName: "documents",
      memory: {
        id: documentId,
        agentId: fixture.runtime.agentId,
        entityId: owner,
        roomId: room,
        worldId: world,
        content: {
          text: "Synthetic agreement reference. Final line preserved.",
        },
        metadata,
      },
    },
  ]);
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

function request(
  method = "GET",
  body?: object,
  authenticated = true,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(
    `http://127.0.0.1:${server.port}/api/documents/${documentId}/pins`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.10",
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}

it("persists reviewed pin placements and rejects stale or unauthenticated changes", async () => {
  expect((await request("GET", undefined, false)).status).toBe(401);
  expect(
    (await request("GET", undefined, false, { "x-server-token": gatewayToken }))
      .status,
  ).toBe(401);
  expect(
    (await request("GET", undefined, true, { "x-server-token": gatewayToken }))
      .status,
  ).toBe(401);
  const first = await request();
  expect(first.status).toBe(200);
  const initial = await first.json();
  expect(initial.targets).toEqual({ agent: false, roomIds: [] });
  const patch = {
    agent: true,
    roomIds: [room],
    expectedPinRevision: initial.pinRevision,
  };
  expect((await request("PATCH", patch, false)).status).toBe(401);
  const saved = await request("PATCH", patch);
  expect(saved.status).toBe(200);
  const persisted = await fixture.runtime.adapter.getDocument({
    agentId: fixture.runtime.agentId,
    documentId,
    requesterEntityId: owner,
    requesterRole: "OWNER",
    requesterRoomIds: [],
  });
  expect(persisted?.metadata).toMatchObject({
    scope: "owner-private",
    pinTargets: { agent: true, roomIds: [room] },
  });
  expect(persisted?.content.text).toBe(
    "Synthetic agreement reference. Final line preserved.",
  );
  expect(
    (
      await request("PATCH", {
        agent: false,
        roomIds: [],
        expectedPinRevision: initial.pinRevision,
      })
    ).status,
  ).toBe(409);
  const current = await request();
  expect(current.status).toBe(200);
  const reviewed = await current.json();
  expect(reviewed.targets).toEqual({ agent: true, roomIds: [room] });
  expect(
    (
      await request("PATCH", {
        agent: false,
        roomIds: [],
        expectedPinRevision: reviewed.pinRevision,
      })
    ).status,
  ).toBe(200);
  const cleared = await request();
  expect(cleared.status).toBe(200);
  expect((await cleared.json()).targets).toEqual({ agent: false, roomIds: [] });
}, 120_000);
