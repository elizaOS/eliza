/** Real owner/gateway HTTP admission over the canonical file-backed Notes service. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { registerHttpPluginRoutes } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { notesRoutes } from "../../../plugins/plugin-notes/src/routes.ts";
import { NotesService } from "../../../plugins/plugin-notes/src/service.ts";
import { NotesStore } from "../../../plugins/plugin-notes/src/store.ts";
import { NOTES_TRASH_RETENTION_MS } from "../../../plugins/plugin-notes/src/trash-retention.ts";
import type { NotesTrashRecordingCleanup } from "../../../plugins/plugin-notes/src/types.ts";
import { startApiServer } from "../src/api/server.ts";

const token = randomUUID();
const gateway = randomUUID() + randomUUID();
let directory: string;
let file: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let notes: NotesService;
let verified: NotesTrashRecordingCleanup | undefined;

class LocalRecordingHost extends NotesService {
  constructor(runtime?: IAgentRuntime) {
    super(runtime, {
      store: new NotesStore({ filePath: file }),
      threeDayTrash: true,
      verifyRecordingCleanup: async (receipt) =>
        JSON.stringify(receipt) === JSON.stringify(verified),
    });
  }
  static override async start(runtime: IAgentRuntime) {
    const service = new LocalRecordingHost(runtime);
    await service.initialize();
    return service;
  }
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "notes-trash-http-"));
  file = path.join(directory, "notes.json");
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    AGENT_SERVER_SHARED_SECRET: gateway,
    SECRET_SALT: randomUUID(),
  }))
    vi.stubEnv(key, value);
  for (const key of ["ELIZA_CLOUD_PROVISIONED", "POSTGRES_URL", "DATABASE_URL"])
    vi.stubEnv(key, undefined);
  fixture = await createTestRuntime({
    characterName: `NotesTrashHttp-${randomUUID()}`,
  });
  await fixture.runtime.registerService(LocalRecordingHost);
  await fixture.runtime.getServiceLoadPromise("notes");
  const service = fixture.runtime.getService<NotesService>("notes");
  if (!service) throw new Error("The real Notes service did not start");
  notes = service;
  registerHttpPluginRoutes(fixture.runtime, {
    name: "canonical-notes-trash",
    description: "Canonical Notes owner routes",
    routes: notesRoutes,
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

function call(
  method: string,
  route: string,
  body?: unknown,
  actor: "owner" | "gateway" | "missing" = "owner",
) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(actor === "owner"
        ? { authorization: `Bearer ${token}` }
        : actor === "gateway"
          ? { "x-server-token": gateway }
          : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function trash(content: string, audioId?: string) {
  const note = await notes.createNote({
    content,
    forceNew: true,
    ...(audioId
      ? {
          format: {
            kind: "voice",
            data: {
              recordingId: audioId,
              audio: { audioId, durationMs: 1000 },
            },
          },
        }
      : {}),
  });
  const { snapshot } = await notes.deleteNoteWithCommit(note.id);
  const row = snapshot.trash?.find((row) => row.note.id === note.id);
  if (!row) throw new Error("The deletion did not commit");
  return {
    scope: "entry" as const,
    id: note.id,
    deletedAt: row.deletedAt,
    expectedRevision: snapshot.revision,
  };
}

it("requires the real API owner and the complete current collection revision before Empty commits", async () => {
  const first = await trash(
    "HTTP_EMPTY_HEAD\nComplete selected text\nHTTP_EMPTY_TAIL",
  );
  const review = { scope: "all", expectedRevision: first.expectedRevision };
  const before = await readFile(file, "utf8");
  expect(
    (await call("POST", "/api/notes/trash/erase", review, "missing")).status,
  ).toBe(401);
  expect(
    (await call("POST", "/api/notes/trash/erase", review, "gateway")).status,
  ).toBe(403);
  expect(await readFile(file, "utf8")).toBe(before);
  await trash("Second full reviewed deletion");
  expect((await call("POST", "/api/notes/trash/erase", review)).status).toBe(
    409,
  );
  expect(notes.snapshot().trash).toHaveLength(2);
  const response = await call("POST", "/api/notes/trash/erase", {
    ...review,
    expectedRevision: notes.snapshot().revision,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { erased: 2, state: { trash: [] } },
  });
  expect(JSON.parse(await readFile(file, "utf8")).trash).toEqual([]);
});

it("keeps exact recording cleanup private and pending until an independently verified owner acknowledgement", async () => {
  const entry = await trash(
    "HTTP_VOICE_HEAD\nFull voice transcript\nHTTP_VOICE_TAIL",
    "http-recording",
  );
  const erased = await call("POST", "/api/notes/trash/erase", entry);
  expect(erased.status, await erased.clone().text()).toBe(200);
  const { data } = await erased.json();
  const receipt = data.recordingCleanup[0] as NotesTrashRecordingCleanup;
  expect(receipt).toMatchObject({
    noteId: entry.id,
    audioId: "http-recording",
    deletedAt: entry.deletedAt,
  });
  expect(await readFile(file, "utf8")).not.toContain("HTTP_VOICE_HEAD");
  expect(
    (await call("GET", "/api/notes/trash/recordings", undefined, "gateway"))
      .status,
  ).toBe(403);
  expect(
    (
      await call(
        "POST",
        "/api/notes/trash/recordings/complete",
        receipt,
        "gateway",
      )
    ).status,
  ).toBe(403);
  const state = await (await call("GET", "/api/notes/state")).json();
  expect(state.data).not.toHaveProperty("trashRecordingCleanup");
  const pending = await (
    await call("GET", "/api/notes/trash/recordings")
  ).json();
  expect(pending.data).toEqual([receipt]);
  expect(
    (await call("POST", "/api/notes/trash/recordings/complete", receipt))
      .status,
  ).toBe(409);
  verified = receipt;
  const acknowledged = await call(
    "POST",
    "/api/notes/trash/recordings/complete",
    receipt,
  );
  expect(acknowledged.status, await acknowledged.clone().text()).toBe(200);
  expect(await acknowledged.json()).toMatchObject({
    data: { acknowledged: true },
  });
  expect(
    await (
      await call("POST", "/api/notes/trash/recordings/complete", receipt)
    ).json(),
  ).toMatchObject({ data: { acknowledged: false } });
  expect(
    (await (await call("GET", "/api/notes/trash/recordings")).json()).data,
  ).toEqual([]);
});

it("applies the runtime retention setting only when the host explicitly opts in across real service restarts", async () => {
  const setting = "ELIZA_NOTES_TRASH_RETENTION_DAYS";
  fixture.runtime.setSetting(setting, null);
  const ordinary = await NotesService.start(fixture.runtime);
  let reopened: NotesService | undefined;
  let optedIn: NotesService | undefined;
  try {
    const note = await ordinary.createNote({
      content:
        "BOOTSTRAP_RETENTION_HEAD\nKeep complete authored text until opt-in\nBOOTSTRAP_RETENTION_TAIL",
      forceNew: true,
    });
    await ordinary.deleteNoteWithCommit(note.id);
    const aged = new Date(
      Date.now() - NOTES_TRASH_RETENTION_MS - 1_000,
    ).toISOString();
    await ordinary.store.transact((document) => {
      const row = document.trash?.find((row) => row.note.id === note.id);
      if (!row) throw new Error("Missing stored deletion");
      row.deletedAt = aged;
      row.note.createdAt = aged;
      row.note.updatedAt = aged;
    });
    await ordinary.stop();
    reopened = await NotesService.start(fixture.runtime);
    expect(reopened.snapshot().trash?.map((row) => row.note.id)).toEqual([
      note.id,
    ]);
    const canonicalPath = reopened.store.filePath;
    expect(await readFile(canonicalPath, "utf8")).toContain(
      "BOOTSTRAP_RETENTION_TAIL",
    );
    await reopened.stop();
    fixture.runtime.setSetting(setting, "3");
    optedIn = await NotesService.start(fixture.runtime);
    expect(optedIn.store.filePath).toBe(canonicalPath);
    expect(optedIn.snapshot().trash).toEqual([]);
    expect(await readFile(canonicalPath, "utf8")).not.toContain(
      "BOOTSTRAP_RETENTION_HEAD",
    );
  } finally {
    await ordinary.stop();
    await reopened?.stop();
    await optedIn?.stop();
    fixture.runtime.setSetting(setting, null);
  }
});
