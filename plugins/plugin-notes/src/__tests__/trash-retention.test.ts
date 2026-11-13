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

async function fixture(
  threeDayTrash = true,
  verifyCleanup?: (
    receipt: NotesTrashRecordingCleanup,
    signal?: AbortSignal,
  ) => Promise<boolean>,
) {
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
      verifyRecordingCleanup:
        verifyCleanup ??
        (async (receipt) =>
          JSON.stringify(receipt) === JSON.stringify(verified)),
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

  it("cancels an owner erase queued behind a real store read without changing the reviewed deletion", async () => {
    let persisted: string | null = null;
    let holdRead = false;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new NotesService(undefined, {
      store: new NotesStore({
        agentId: "notes-trash-cancel-queue",
        encryptedPort: {
          agentId: "notes-trash-cancel-queue",
          encryptedAtRest: true,
          read: async () => {
            if (holdRead) {
              holdRead = false;
              entered();
              await held;
            }
            return persisted;
          },
          compareExchange: async (expected, next) => {
            if (expected !== persisted) return false;
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
      "CANCEL_HEAD\nKeep the full recording transcript\nCANCEL_TAIL",
      "cancel-recording",
    );
    const before = persisted;
    holdRead = true;
    const read = service.store.persistedSnapshot();
    await waiting;
    const controller = new AbortController();
    const erase = request(
      service,
      "POST",
      "/api/notes/trash/erase",
      entry,
      true,
      controller.signal,
    );
    controller.abort();
    release();
    await read;
    expect(await erase).toMatchObject({
      status: 499,
      body: { error: { code: "NOTES_REQUEST_CANCELLED" } },
    });
    expect(persisted).toBe(before);
    expect(service.snapshot().trash?.map((row) => row.note.id)).toEqual([
      entry.id,
    ]);
    expect(await service.readTrashRecordingCleanup()).toEqual([]);
    // An explicit fresh request with the unchanged review can still commit.
    expect(
      await request(service, "POST", "/api/notes/trash/erase", entry, true),
    ).toMatchObject({ status: 200, body: { data: { erased: 1 } } });
    expect(await service.readTrashRecordingCleanup()).toHaveLength(1);
  });

  it("retains the recording receipt when cancellation arrives during trusted host verification", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(true, async () => {
      entered();
      await held;
      return true;
    });
    const entry = await trashNote(
      f.service,
      "Keep the cleanup receipt after a cancelled acknowledgement",
      "verified-recording",
    );
    const { value } = await f.service.eraseTrash(entry);
    const receipt = value.recordingCleanup[0];
    if (!receipt) throw new Error("Missing cleanup receipt");
    const before = await f.persisted();
    const controller = new AbortController();
    const acknowledgement = request(
      f.service,
      "POST",
      "/api/notes/trash/recordings/complete",
      receipt,
      true,
      controller.signal,
    );
    await waiting;
    controller.abort();
    release();
    expect(await acknowledgement).toMatchObject({
      status: 499,
      body: { error: { code: "NOTES_REQUEST_CANCELLED" } },
    });
    expect(await f.persisted()).toBe(before);
    expect(await f.service.readTrashRecordingCleanup()).toEqual([receipt]);
    expect(await f.service.acknowledgeTrashRecordingCleanup(receipt)).toBe(
      true,
    );
    expect(await f.service.readTrashRecordingCleanup()).toEqual([]);
  });

  it("recovers one committed recording receipt after a lost erase acknowledgement without replaying the write", async () => {
    let persisted: string | null = null;
    let loseAcknowledgement = false;
    let writes = 0;
    const port = {
      agentId: "notes-trash-lost-ack",
      encryptedAtRest: true as const,
      read: async () => persisted,
      compareExchange: async (expected: string | null, next: string) => {
        if (expected !== persisted) return false;
        persisted = next;
        writes++;
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error(
            "Controlled lost acknowledgement after the durable commit",
          );
        }
        return true;
      },
    };
    const open = async () => {
      const service = new NotesService(undefined, {
        store: new NotesStore({ agentId: port.agentId, encryptedPort: port }),
        threeDayTrash: true,
      });
      services.push(service);
      await service.initialize();
      return service;
    };
    const first = await open();
    const peer = await open();
    const entry = await trashNote(
      first,
      "LOST_ACK_HEAD\nComplete authored text\nLOST_ACK_TAIL",
      "lost-ack-recording",
    );
    loseAcknowledgement = true;
    expect(
      await request(first, "POST", "/api/notes/trash/erase", entry, true),
    ).toMatchObject({
      status: 500,
      body: { error: { code: "NOTES_STORE_WRITE_FAILED" } },
    });
    const durable = JSON.parse(persisted ?? "null");
    expect(durable.trash).toEqual([]);
    expect(durable.trashRecordingCleanup).toHaveLength(1);
    expect(durable.trashRecordingCleanup[0]).toMatchObject({
      noteId: entry.id,
      audioId: "lost-ack-recording",
      deletedAt: entry.deletedAt,
    });
    // A failed acknowledgement must not turn the durable pending receipt into
    // a successful empty response from the old cache.
    await expect(first.readTrashRecordingCleanup()).rejects.toMatchObject({
      code: "NOTES_STORE_WRITE_FAILED",
    });
    expect(first.status().phase).toBe("error");
    await expect(peer.readTrashRecordingCleanup()).rejects.toMatchObject({
      code: "NOTES_STORE_WRITE_FAILED",
    });
    expect(() => peer.snapshot()).toThrow();
    const committedWrites = writes;
    await first.stop();
    expect(peer.status().phase).toBe("error");
    await peer.stop();
    const restarted = await open();
    expect(restarted.snapshot().trash).toEqual([]);
    expect(await restarted.readTrashRecordingCleanup()).toEqual(
      durable.trashRecordingCleanup,
    );
    expect(
      await request(restarted, "POST", "/api/notes/trash/erase", entry, true),
    ).toMatchObject({ status: 409 });
    expect(writes).toBe(committedWrites);
  });

  it("keeps the entire reviewed Empty collection when one recording cannot be verified", async () => {
    const f = await fixture();
    await trashNote(f.service, "Preserve this ordinary note too");
    await trashNote(
      f.service,
      "Unverifiable native recording",
      "r".repeat(101),
    );
    const before = await f.persisted();
    const review = {
      scope: "all",
      expectedRevision: f.service.snapshot().revision,
    };
    expect(
      await request(f.service, "POST", "/api/notes/trash/erase", review, true),
    ).toMatchObject({
      status: 409,
      body: { error: { code: "NOTES_TRASH_RECORDING_UNAVAILABLE" } },
    });
    expect(await f.persisted()).toBe(before);
    expect(f.service.snapshot().trash).toHaveLength(2);
    expect(await f.service.readTrashRecordingCleanup()).toEqual([]);
  });

  it.each([
    { outcome: "committed success", failure: "none" },
    { outcome: "lost acknowledgement", failure: "cas" },
    { outcome: "failed readback", failure: "readback" },
    { outcome: "mismatched readback", failure: "mismatch" },
  ])(
    "keeps the durable receipt truthful after cancellation during $outcome",
    async ({ failure }) => {
      let persisted: string | null = null;
      let previous: string | null = null;
      let abortAtCommit = false;
      let readbackConsumed = false;
      const controller = new AbortController();
      const agentId = "notes-trash-abort-after-commit";
      const service = new NotesService(undefined, {
        store: new NotesStore({
          agentId,
          encryptedPort: {
            agentId,
            encryptedAtRest: true,
            read: async () => {
              if (abortAtCommit && !readbackConsumed) {
                readbackConsumed = true;
                if (failure === "readback")
                  throw new Error("Controlled readback failure after commit");
                if (failure === "mismatch") return previous;
              }
              return persisted;
            },
            compareExchange: async (expected, next) => {
              if (expected !== persisted) return false;
              previous = persisted;
              persisted = next;
              if (abortAtCommit) {
                controller.abort();
                if (failure === "cas")
                  throw new Error(
                    "Controlled lost acknowledgement after commit and cancellation",
                  );
              }
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
        "Already admitted erase must retain its effect receipt",
        "cancelled-after-commit",
      );
      abortAtCommit = true;
      const response = await request(
        service,
        "POST",
        "/api/notes/trash/erase",
        entry,
        true,
        controller.signal,
      );
      expect(response).toMatchObject(
        failure !== "none"
          ? {
              status: 500,
              body: { error: { code: "NOTES_STORE_WRITE_FAILED" } },
            }
          : { status: 200, body: { data: { erased: 1 } } },
      );
      const durable = JSON.parse(persisted ?? "null");
      expect(durable.trash).toEqual([]);
      expect(durable.trashRecordingCleanup).toHaveLength(1);
      expect(durable.trashRecordingCleanup[0]).toMatchObject({
        noteId: entry.id,
        audioId: "cancelled-after-commit",
        deletedAt: entry.deletedAt,
      });
      if (failure !== "none")
        await expect(service.readTrashRecordingCleanup()).rejects.toMatchObject(
          { code: "NOTES_STORE_WRITE_FAILED" },
        );
      else
        expect(await service.readTrashRecordingCleanup()).toEqual(
          durable.trashRecordingCleanup,
        );
    },
  );
});
