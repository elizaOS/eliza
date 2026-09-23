/** Exercises read-bound replacement conflicts against real per-agent files and the capability broker. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, createCharacter, Service } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interact } from "../interact.js";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";

const directories: string[] = [];
const services: NotesService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
class BroadcastCapture extends Service {
  capabilityDescription = "Capture Notes state events at the delivery port";
  broadcastWs = vi.fn();
  async stop(): Promise<void> {}
}
async function setup() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-revision-"));
  directories.push(stateDir);
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Notes revision" }),
    enableAutonomy: false,
  });
  const capture = new BroadcastCapture(runtime);
  vi.spyOn(runtime, "getServiceLoadPromise").mockResolvedValue(capture);
  const open = async () => {
    const service = new NotesService(runtime, {
      store: new NotesStore({ stateDir, agentId: "revision-owner" }),
    });
    services.push(service);
    await service.initialize();
    return service;
  };
  return { first: await open(), second: await open(), open, capture };
}

describe("read-bound note replacement", () => {
  it.each(["id", "title", "query"] as const)(
    "rejects a stale %s replacement without a receipt, event, revision or durable change",
    async (selector) => {
      const h = await setup();
      const note = await h.first.createNote({
        title: "Trip plan",
        body: "Original α\nOriginal final 🌲",
      });
      const untouched = await h.first.createNote({
        title: "Separate",
        body: "Complete unrelated 🦉",
      });
      const read = await interact("get-note", { id: note.id }, h.second);
      if (!read.state) throw new Error("Expected authoritative read snapshot");
      const expectedRevision = read.state.revision;
      const target = { [selector]: selector === "id" ? note.id : note.title };
      const winnerContent =
        "Trip plan\nOriginal α\nConfirmed address: 14 Orchard Lane.\nWINNER FINAL 🧭";
      const winner = await interact(
        "update-note",
        { ...target, content: winnerContent, expectedRevision },
        h.first,
      );
      expect(winner.success).toBe(true);
      expect(winner.effectReceipts).toHaveLength(1);
      const snapshot = h.first.snapshot();
      const disk = await fs.readFile(h.first.store.filePath, "utf8");
      const updateEvents = h.capture.broadcastWs;
      updateEvents.mockClear();
      const stale = await interact(
        "update-note",
        {
          ...target,
          content: "Trip plan\nOriginal α\nStale unrelated change 🪶",
          expectedRevision,
        },
        h.second,
      );
      expect(stale).toMatchObject({
        success: false,
        error: { code: "NOTES_EDIT_CONFLICT" },
      });
      expect(stale.effectReceipts).toBeUndefined();
      expect(updateEvents).not.toHaveBeenCalled();
      expect(h.second.snapshot()).toEqual(snapshot);
      expect(h.second.getNote(untouched.id)).toEqual(untouched);
      expect(await fs.readFile(h.first.store.filePath, "utf8")).toBe(disk);

      await h.first.stop();
      await h.second.stop();
      services.splice(services.indexOf(h.first), 1);
      services.splice(services.indexOf(h.second), 1);
      const restarted = await h.open();
      expect(restarted.snapshot()).toEqual(snapshot);
      expect(restarted.getNote(note.id).body).toBe(
        winnerContent.split("\n").slice(1).join("\n"),
      );
    },
  );

  it.each([undefined, null, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1])(
    "rejects missing or invalid revision %s before replacement",
    async (expectedRevision) => {
      const { first } = await setup();
      const note = await first.createNote({
        title: "Original",
        body: "Preserve all bytes",
      });
      const before = first.snapshot();
      const result = await interact(
        "update-note",
        { id: note.id, content: "Replacement", expectedRevision },
        first,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: "NOTES_EDIT_REVISION_REQUIRED" },
      });
      expect(first.snapshot()).toEqual(before);
      await expect(
        first.updateNoteWithCommit(
          note.id,
          { body: "Direct" },
          expectedRevision,
        ),
      ).rejects.toMatchObject({ code: "NOTES_EDIT_REVISION_REQUIRED" });
    },
  );

  it("checks queued writes inside the barrier and conservatively conflicts on another note's mutation", async () => {
    const { first, second } = await setup();
    const note = await first.createNote({ title: "Target", body: "green" });
    const revision = first.snapshot().revision;
    const results = await Promise.allSettled([
      first.updateNoteWithCommit(note.id, { body: "orange" }, revision),
      second.updateNoteByLookupWithCommit(
        "title",
        note.title,
        { body: "violet" },
        revision,
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(first.getNote(note.id).body).toBe("orange");
    const readRevision = first.snapshot().revision;
    await second.createNote({ title: "Other", body: "Other mutation" });
    await expect(
      first.updateNote(note.id, { body: "stale" }, readRevision),
    ).rejects.toMatchObject({ code: "NOTES_EDIT_CONFLICT" });
    await first.updateNote(note.id, {
      textEdit: { field: "body", oldText: "orange", newText: "amber" },
    });
    expect(first.getNote(note.id).body).toBe("amber");
    await expect(
      first.updateNote(
        note.id,
        { textEdit: { field: "body", oldText: "amber", newText: "red" } },
        readRevision,
      ),
    ).rejects.toMatchObject({ code: "NOTES_EDIT_CONFLICT" });
  });
});
