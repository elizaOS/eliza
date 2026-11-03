import { describe, expect, it } from "vitest";
import { originalRequestsNotesDeletion } from "./notes-delete-intent.ts";

describe("originalRequestsNotesDeletion", () => {
  it("admits a direct Notes deletion request", () => {
    expect(
      originalRequestsNotesDeletion("Delete the note about groceries"),
    ).toBe(true);
    expect(
      originalRequestsNotesDeletion("Can you please remove my note about rent"),
    ).toBe(true);
  });

  it("declines when a later clause cancels the deletion", () => {
    expect(
      originalRequestsNotesDeletion(
        "Delete the note about groceries, never mind",
      ),
    ).toBe(false);
    expect(
      originalRequestsNotesDeletion(
        "Delete the note about groceries but don't delete it yet",
      ),
    ).toBe(false);
  });

  it("declines when the owner asks to read or show the note instead", () => {
    expect(
      originalRequestsNotesDeletion(
        "Delete the note about groceries, instead read it to me",
      ),
    ).toBe(false);
    expect(
      originalRequestsNotesDeletion(
        "Delete my note about rent; instead show it",
      ),
    ).toBe(false);
  });

  it("declines read or show instead with other word order or punctuation", () => {
    const requests = [
      "Delete the note about groceries, instead please read it",
      "Delete the note about groceries, instead, read it",
      "Delete the note about groceries; please read it instead",
      "Delete the note about groceries and show it instead",
      "Delete the note about groceries, read it to me instead",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual([]);
  });
});
