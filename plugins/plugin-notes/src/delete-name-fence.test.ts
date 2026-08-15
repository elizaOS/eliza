/**
 * Tests that name-based note deletion is bound to a complete title phrase in
 * the owner's current wording before the transactional delete commits.
 */
import { describe, expect, it } from "vitest";
import { NotesService } from "./service";

async function seeded(title = "wifi password"): Promise<NotesService> {
  const service = new NotesService();
  await service.createNoteWithCommit({
    title,
    body: "hunter2-not-really",
    color: "yellow",
  });
  return service;
}

describe("delete-note owner-text fence", () => {
  it("blocks a name-translated delete and names the near-miss", async () => {
    const service = await seeded();
    await expect(
      service.deleteNoteByLookupWithCommit("title", "wifi password", {
        requireTitleInText: "delete the wifi credentials note",
      }),
    ).rejects.toMatchObject({ code: "NOTES_DELETE_NAME_MISMATCH" });
    expect(service.snapshot().notes).toHaveLength(1);
  });

  it("deletes when the user actually named the note", async () => {
    const service = await seeded();
    const removed = await service.deleteNoteByLookupWithCommit(
      "title",
      "wifi password",
      { requireTitleInText: "delete the wifi password note" },
    );
    expect(removed.value.title).toBe("wifi password");
    expect(service.snapshot().notes).toHaveLength(0);
  });

  it("rejects substring collisions as different names", async () => {
    const service = await seeded("art");
    await expect(
      service.deleteNoteByLookupWithCommit("title", "art", {
        requireTitleInText: "delete the cart note",
      }),
    ).rejects.toMatchObject({ code: "NOTES_DELETE_NAME_MISMATCH" });
    expect(service.snapshot().notes).toHaveLength(1);
  });

  it("treats Unicode combining marks as part of the surrounding name", async () => {
    const service = await seeded("i");
    await expect(
      service.deleteNoteByLookupWithCommit("title", "i", {
        requireTitleInText: "delete the İ note",
      }),
    ).rejects.toMatchObject({ code: "NOTES_DELETE_NAME_MISMATCH" });
    expect(service.snapshot().notes).toHaveLength(1);
  });

  it("accepts canonically equivalent multilingual title spelling", async () => {
    const service = await seeded("café");
    const removed = await service.deleteNoteByLookupWithCommit(
      "title",
      "café",
      { requireTitleInText: "delete the cafe\u0301 note" },
    );
    expect(removed.value.title).toBe("café");
    expect(service.snapshot().notes).toHaveLength(0);
  });

  it("accepts an exactly named punctuation-bearing title", async () => {
    const service = await seeded("C++");
    const removed = await service.deleteNoteByLookupWithCommit(
      "title",
      "C++",
      { requireTitleInText: 'delete the "C++" note' },
    );
    expect(removed.value.title).toBe("C++");
    expect(service.snapshot().notes).toHaveLength(0);
  });

  it("keeps historical behavior when no owner text is supplied", async () => {
    const service = await seeded();
    const removed = await service.deleteNoteByLookupWithCommit(
      "title",
      "wifi password",
    );
    expect(removed.value.title).toBe("wifi password");
  });
});
