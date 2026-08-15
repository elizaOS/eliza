/**
 * Matrix F4 (tj-a6b65b4576ad86): the planner translated the user's
 * "wifi credentials" into the stored title "wifi password" (it had the note
 * list in prior-turn context), so delete-note removed a note the user never
 * named — via an EXACT-title lookup no fuzzy guard could catch. The fence:
 * when the caller supplies the user's original words, the resolved title
 * must appear in them or the delete fails structurally and the reply asks.
 */
import { describe, expect, it } from "vitest";
import { NotesService } from "./service";

async function seeded(): Promise<NotesService> {
  const service = new NotesService();
  await service.createNoteWithCommit({
    title: "wifi password",
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

  it("keeps historical behavior when no owner text is supplied", async () => {
    const service = await seeded();
    const removed = await service.deleteNoteByLookupWithCommit(
      "title",
      "wifi password",
    );
    expect(removed.value.title).toBe("wifi password");
  });
});
