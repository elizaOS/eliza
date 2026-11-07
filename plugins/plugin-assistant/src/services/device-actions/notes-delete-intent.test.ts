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
      "Delete the note about groceries, or rather read it to me instead",
      "Delete the note about groceries, actually could you show it to me instead",
      "Delete the note about groceries instead I'd like you to read it aloud",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual([]);
  });

  it("declines read or show instead when a long clause separates them", () => {
    const requests = [
      "Delete the note about groceries, instead of archiving every attached receipt and every revision for compliance, please just read it aloud to me",
      "Delete the note about groceries and show it to me, with every attached receipt and every revision kept for the yearly compliance audit, instead",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual([]);
  });

  it("admits a contrastive deletion whose wording only mentions read or show", () => {
    const requests = [
      "Delete the note about show times instead of keeping the draft",
      "Delete the note I already read instead of archiving it",
      "Delete the note about read receipts instead of the backup",
      "Delete the note I just read instead of the old one",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual(requests);
  });

  it("admits a contrastive deletion whose note title reads like a read or show request", () => {
    const requests = [
      "Delete the note titled read me instead of the draft",
      "Delete the note about read it twice tips instead of the old FAQ",
      "Delete the note called show it to clients instead of the internal draft",
      "Delete the note named show me the money instead of keeping the joke",
      "Delete the note about show it weekly instead of the daily one",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual(requests);
  });

  it("admits a contrastive deletion whose topic joins words before read or show", () => {
    const requests = [
      "Delete the note about groceries and show times instead of the draft",
      "Delete the note about groceries or show times instead of keeping both",
      "Delete the note about groceries then show times instead of the draft",
      "Delete the note about reading lists and show schedules instead of the draft",
      "Delete the note about invoices and read receipts instead of the backup",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual(requests);
  });

  it("admits a contrastive deletion whose topic puts punctuation before read or show", () => {
    const requests = [
      "Delete the note about Agenda: show times instead of the draft",
      "Delete the note about Q3; show schedules instead of the draft",
      "Delete the note about groceries, show times instead of the draft",
      "Delete the note about groceries - show times instead of the draft",
      "Delete the note about wait—show times instead of the draft",
      "Delete the note about groceries. Show times instead of the draft",
      "Delete the note titled Show: read aloud tips instead of the draft",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual(requests);
  });

  it("admits a deletion whose topic holds read or show before an adverbial instead or instead of deleting", () => {
    const requests = [
      "Delete the note about Agenda: show times instead of deleting the backup",
      "Delete the note about Agenda: show times instead of removing the draft",
      "Delete the note about Agenda: show times instead",
      "Delete the note about Q3; show schedules instead of deleting the backup",
      "Delete the note about groceries, show times instead of deleting it",
      "Delete the note titled Show: read aloud tips instead of deleting the draft",
      "Delete the note about groceries and show times instead",
      "Delete the note titled read me instead",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual(requests);
  });

  it("admits a deletion whose topic or title starts with read or show it before an adverbial instead or instead of deleting", () => {
    const requests = [
      "Delete the note called show it to clients instead",
      "Delete the note about read it twice tips instead",
      "Delete the note about show it weekly instead",
      "Delete the note called show it to clients instead of deleting the backup",
      "Delete the note about read it twice tips instead of deleting the old FAQ",
      "Delete the note about show it weekly instead of removing the daily one",
      "Delete the note titled read it later instead",
      'Delete the note titled "read it later" instead of deleting the draft',
      "Delete the note named ‘show them around’ instead",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual(requests);
  });

  it("declines read or show after punctuation when it names the note", () => {
    const requests = [
      "Delete the note about groceries, show it to me instead of the draft",
      "Delete the note about rent; just show it instead",
      "Delete the note about rent. Read it instead of deleting it",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual([]);
  });

  it("declines read or show after a joining word when it names the note", () => {
    const requests = [
      "Delete the note about groceries and show it to me instead",
      "Delete the note about groceries and show it to me instead of the draft",
      "Delete the note about rent or just show it instead of deleting it",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual([]);
  });

  it("declines read or show instead with me or us before the note, or read aloud", () => {
    const requests = [
      "Delete the note about groceries; please show me the note instead",
      "Delete the note about groceries and read me the note instead",
      "Delete the note about groceries and read me it instead",
      "Delete the note about groceries, show us the note instead of the draft",
      "Delete the note about groceries; please read aloud instead",
      "Delete the note about groceries and read out loud to me instead",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual([]);
  });

  it("admits a deletion whose quoted title holds punctuation or a joining word before read or show", () => {
    const requests = [
      'Delete the note titled "Agenda: show it to clients" instead of the draft',
      'Delete the note titled "Save and read it later" instead of the draft',
      'Delete the note titled "Agenda: show it to clients" instead of deleting the backup',
      "Delete the note called “Q3; read me the note” instead",
      "Delete the note named 'Save and show it later' instead of the draft",
      "Delete the note titled read aloud instead",
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual(requests);
  });

  it("declines when the owner asks to read the note instead of deleting it", () => {
    const requests = [
      "Delete the note, I'd like you to read it instead of deleting it",
      "Delete the note about groceries, I want you to show it to me instead of removing it",
      "Delete the note called show it to clients, I'd like you to read it instead of deleting it",
      "Delete the note about show it weekly, read it to me instead",
      "Delete the note about groceries; show it instead of deleting it",
      'Delete the note titled "Agenda: show it to clients"; read it to me instead',
    ];
    expect(requests.filter(originalRequestsNotesDeletion)).toEqual([]);
  });
});
