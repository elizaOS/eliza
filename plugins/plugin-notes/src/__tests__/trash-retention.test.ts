import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { notesRoutes } from "../routes.js";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";
import { NOTES_TRASH_RETENTION_MS } from "../trash-retention.js";
import type { NotesTrashRecordingCleanup } from "../types.js";

const directories: string[] = [];
const services: NotesService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(threeDayTrash = true) {
  const directory = await mkdtemp(join(tmpdir(), "canonical-trash-"));
  directories.push(directory);
  const filePath = join(directory, "notes.json");
  let time = Date.parse("2026-10-01T12:00:00.000Z");
  let sequence = 0;
  let verified: NotesTrashRecordingCleanup | undefined;
  const now = () => new Date(time);
  const open = async () => {
    const service = new NotesService(undefined, {
      store: new NotesStore({ filePath, now }),
      now,
      createId: () => `note-trash-${++sequence}`,
      threeDayTrash,
      verifyRecordingCleanup: async (receipt) =>
        JSON.stringify(receipt) === JSON.stringify(verified),
    });
    services.push(service);
    await service.initialize();
    return service;
  };
  return {
    service: await open(),
    open,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    verify: (receipt: NotesTrashRecordingCleanup) => {
      verified = receipt;
    },
    persisted: () => readFile(filePath, "utf8"),
  };
}

async function trashNote(
  service: NotesService,
  content: string,
  audioId?: string,
) {
  const note = await service.createNote({
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
  const { snapshot } = await service.deleteNoteWithCommit(note.id);
  const entry = snapshot.trash?.find((item) => item.note.id === note.id);
  if (!entry) throw new Error("Missing committed Trash row");
  return {
    scope: "entry" as const,
    id: note.id,
    deletedAt: entry.deletedAt,
    expectedRevision: snapshot.revision,
  };
}

async function request(
  service: NotesService,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  owner?: boolean,
  signal = new AbortController().signal,
) {
  const route = notesRoutes.find(
    (candidate) => candidate.type === method && candidate.path === path,
  );
  if (!route?.routeHandler) throw new Error(`Missing Notes route: ${path}`);
  const runtime = {
    getService: () => service,
    reportError: () => {},
  } as unknown as IAgentRuntime;
  const context: RouteHandlerContext = {
    body,
    method,
    path,
    headers: {},
    params: {},
    query: {},
    signal,
    runtime,
    inProcess: true,
    ...(owner === undefined
      ? {}
      : {
          accessContext: {
            isOwner: owner,
            role: owner ? "OWNER" : undefined,
            requesterEntityId: "0c846f26-58e3-4d66-8f86-d848cb331a64",
            source: "owner-api-token",
          },
        }),
  };
  return route.routeHandler(context);
}

describe("canonical Notes Trash retention", () => {
  it("preserves an unconfigured host's retained records across restart", async () => {
    const f = await fixture(false);
    const entry = await trashNote(
      f.service,
      "Retained by existing host policy",
    );
    await f.service.stop();
    f.advance(NOTES_TRASH_RETENTION_MS);
    const restarted = await f.open();
    expect((await restarted.readSnapshot()).trash).toHaveLength(1);
    await expect(restarted.eraseTrash(entry)).rejects.toMatchObject({
      code: "NOTES_TRASH_RETENTION_DISABLED",
    });
    expect(
      (await restarted.restoreNoteWithCommit(entry.id, entry.expectedRevision))
        .value.id,
    ).toBe(entry.id);
  });

  it("refuses restore at the exact cutoff and persists automatic erase", async () => {
    const f = await fixture();
    const entry = await trashNote(f.service, "Sensitive cutoff text");
    f.advance(NOTES_TRASH_RETENTION_MS - 1);
    expect((await f.service.readSnapshot()).trash).toHaveLength(1);
    f.advance(1);
    await expect(
      f.service.restoreNoteWithCommit(entry.id, entry.expectedRevision),
    ).rejects.toMatchObject({ code: "NOTES_TRASH_EXPIRED" });
    const result = await request(
      f.service,
      "GET",
      "/api/notes/state",
      undefined,
      true,
    );
    expect(result).toMatchObject({
      status: 200,
      body: { data: { trash: [] } },
    });
    expect(await f.persisted()).not.toContain("Sensitive cutoff text");
    await f.service.stop();
    expect((await f.open()).snapshot().trash).toEqual([]);
  });

  it("gives restored and re-deleted notes a new deadline and rejects the prior review", async () => {
    const f = await fixture();
    const entry = await trashNote(f.service, "Keep the re-deleted note");
    f.advance(NOTES_TRASH_RETENTION_MS - 1);
    await f.service.restoreNoteWithCommit(entry.id, entry.expectedRevision);
    await f.service.deleteNoteWithCommit(entry.id);
    f.advance(1);
    const current = await f.service.readSnapshot();
    expect(current.trash).toHaveLength(1);
    await expect(f.service.eraseTrash(entry)).rejects.toMatchObject({
      code: "NOTES_EDIT_CONFLICT",
    });
    await expect(
      f.service.eraseTrash({ ...entry, expectedRevision: current.revision }),
    ).rejects.toMatchObject({ code: "NOTES_NOT_FOUND" });
    expect(f.service.snapshot()).toEqual(current);
  });

  it("commits expired recording work when the opted-in service restarts", async () => {
    const f = await fixture();
    const entry = await trashNote(
      f.service,
      "Expired voice transcript",
      "recording-expired",
    );
    await f.service.stop();
    f.advance(NOTES_TRASH_RETENTION_MS);
    const restarted = await f.open();
    expect(restarted.snapshot().trash).toEqual([]);
    expect(await restarted.readTrashRecordingCleanup()).toMatchObject([
      {
        noteId: entry.id,
        audioId: "recording-expired",
        deletedAt: entry.deletedAt,
      },
    ]);
    expect(await f.persisted()).not.toContain("Expired voice transcript");
  });

  it("requires the current owner and current collection review for Empty", async () => {
    const f = await fixture();
    const entry = await trashNote(f.service, "First deleted note");
    const path = "/api/notes/trash/erase";
    const review = { scope: "all", expectedRevision: entry.expectedRevision };
    for (const owner of [undefined, false]) {
      expect(
        await request(f.service, "POST", path, review, owner),
      ).toMatchObject({ status: 403 });
    }
    await trashNote(f.service, "Later deletion");
    expect(await request(f.service, "POST", path, review, true)).toMatchObject({
      status: 409,
    });
    const latest = f.service.snapshot();
    expect(latest.trash).toHaveLength(2);
    expect(
      await request(
        f.service,
        "POST",
        path,
        { ...review, expectedRevision: latest.revision },
        true,
      ),
    ).toMatchObject({
      status: 200,
      body: { data: { erased: 2, state: { trash: [] } } },
    });
  });

  it("retains exact recording work until a trusted host confirms the erase", async () => {
    const f = await fixture();
    const entry = await trashNote(
      f.service,
      "Voice transcript to erase",
      "recording-a",
    );
    const { value } = await f.service.eraseTrash(entry);
    const receipt = value.recordingCleanup[0];
    if (!receipt) throw new Error("Missing recording cleanup receipt");
    expect(receipt).toMatchObject({
      noteId: entry.id,
      audioId: "recording-a",
      deletedAt: entry.deletedAt,
    });
    expect(value.erased).toBe(1);
    expect(await f.persisted()).not.toContain("Voice transcript to erase");
    await f.service.stop();
    const restarted = await f.open();
    expect(restarted.snapshot()).not.toHaveProperty("trashRecordingCleanup");
    expect(await restarted.readTrashRecordingCleanup()).toEqual([receipt]);
    expect(
      await restarted.acknowledgeTrashRecordingCleanup({
        ...receipt,
        audioId: "recording-other",
      }),
    ).toBe(false);
    await expect(
      restarted.acknowledgeTrashRecordingCleanup(receipt),
    ).rejects.toMatchObject({
      code: "NOTES_TRASH_RECORDING_UNAVAILABLE",
    });
    expect(await restarted.readTrashRecordingCleanup()).toEqual([receipt]);
    f.verify(receipt);
    expect(await restarted.acknowledgeTrashRecordingCleanup(receipt)).toBe(
      true,
    );
    expect(await restarted.acknowledgeTrashRecordingCleanup(receipt)).toBe(
      false,
    );
    expect(await restarted.readTrashRecordingCleanup()).toEqual([]);
  });

  it("refuses an audio claim shared by a retained note", async () => {
    const f = await fixture();
    const entry = await trashNote(
      f.service,
      "Trashed audio reference",
      "recording-shared",
    );
    await f.service.createNote({
      content: "Live audio reference",
      forceNew: true,
      format: {
        kind: "voice",
        data: {
          recordingId: "recording-shared",
          audio: { audioId: "recording-shared" },
        },
      },
    });
    await expect(
      f.service.eraseTrash({
        ...entry,
        expectedRevision: f.service.snapshot().revision,
      }),
    ).rejects.toMatchObject({ code: "NOTES_TRASH_RECORDING_UNAVAILABLE" });
    f.advance(NOTES_TRASH_RETENTION_MS);
    expect((await f.service.readSnapshot()).trash).toHaveLength(1);
    expect(await f.service.readTrashRecordingCleanup()).toEqual([]);
  });

  it.each(["audioId", "recordingId"] as const)(
    "keeps erase blocked by an ambiguous retained %s reference",
    async (claim) => {
      const f = await fixture();
      const entry = await trashNote(
        f.service,
        "Reviewed voice note",
        "audio-a",
      );
      const live = await f.service.createNote({
        content: "Keep the uncertain audio attachment",
        forceNew: true,
        format: {
          kind: "voice",
          data: {
            recordingId: claim === "recordingId" ? "audio-a" : "audio-b",
            audio: { audioId: claim === "audioId" ? "audio-a" : "audio-b" },
          },
        },
      });
      const before = await f.persisted();
      await expect(
        f.service.eraseTrash({
          ...entry,
          expectedRevision: f.service.snapshot().revision,
        }),
      ).rejects.toMatchObject({ code: "NOTES_TRASH_RECORDING_UNAVAILABLE" });
      f.advance(NOTES_TRASH_RETENTION_MS);
      const view = await f.service.readSnapshot();
      expect(view.notes.map((note) => note.id)).toContain(live.id);
      expect(view.trash?.map((row) => row.note.id)).toEqual([entry.id]);
      expect(await f.service.readTrashRecordingCleanup()).toEqual([]);
      expect(await f.persisted()).toBe(before);
    },
  );

  it("refuses a new ambiguous attachment while exact recording cleanup is pending", async () => {
    const f = await fixture();
    const entry = await trashNote(f.service, "Erased voice note", "audio-a");
    const { value } = await f.service.eraseTrash(entry);
    const before = await f.persisted();
    await expect(
      f.service.createNote({
        content: "Conflicting attachment",
        forceNew: true,
        format: {
          kind: "voice",
          data: { recordingId: "audio-b", audio: { audioId: "audio-a" } },
        },
      }),
    ).rejects.toMatchObject({ code: "NOTES_VALIDATION_FAILED" });
    expect(await f.service.readTrashRecordingCleanup()).toEqual(
      value.recordingCleanup,
    );
    expect(await f.persisted()).toBe(before);
  });

  it("holds recording metadata outside the native identity bound", async () => {
    const f = await fixture();
    const supported = await trashNote(
      f.service,
      "Valid native ID",
      "x".repeat(100),
    );
    const invalid = await trashNote(
      f.service,
      "Unverifiable native ID",
      "x".repeat(101),
    );
    await expect(f.service.eraseTrash(invalid)).rejects.toMatchObject({
      code: "NOTES_TRASH_RECORDING_UNAVAILABLE",
    });
    f.advance(NOTES_TRASH_RETENTION_MS);
    expect(
      (await f.service.readSnapshot()).trash?.map((entry) => entry.note.id),
    ).toEqual([invalid.id]);
    expect(await f.service.readTrashRecordingCleanup()).toMatchObject([
      { noteId: supported.id, audioId: "x".repeat(100) },
    ]);
  });

  it("keeps note and recording work unchanged when the store refuses the commit", async () => {
    let persisted: string | null = null;
    let writable = true;
    const agentId = "notes-trash-storage-test";
    const service = new NotesService(undefined, {
      store: new NotesStore({
        agentId,
        encryptedPort: {
          agentId,
          encryptedAtRest: true,
          read: async () => persisted,
          compareExchange: async (expected, next) => {
            if (!writable || expected !== persisted) return false;
            persisted = next;
            return true;
          },
        },
      }),
      threeDayTrash: true,
    });
    services.push(service);
    await service.initialize();
    const entry = await trashNote(
      service,
      "Keep this note on write failure",
      "recording-cas",
    );
    const before = persisted;
    writable = false;
    await expect(service.eraseTrash(entry)).rejects.toMatchObject({
      code: "NOTES_EDIT_CONFLICT",
    });
    expect(persisted).toBe(before);
    expect(service.snapshot().trash?.map((row) => row.note.id)).toEqual([
      entry.id,
    ]);
    expect(await service.readTrashRecordingCleanup()).toEqual([]);
  });

  it("serializes restore and erase so only one operation can win", async () => {
    const f = await fixture();
    const entry = await trashNote(
      f.service,
      "One transaction wins",
      "recording-race",
    );
    const results = await Promise.allSettled([
      f.service.restoreNoteWithCommit(entry.id, entry.expectedRevision),
      f.service.eraseTrash(entry),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const { notes, trash } = f.service.snapshot();
    expect(trash).toEqual([]);
    expect(
      notes.length + (await f.service.readTrashRecordingCleanup()).length,
    ).toBe(1);
  });
});
