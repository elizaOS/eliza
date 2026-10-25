import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stampNoteChanges } from "../src/client/note-dates.ts";
import { queryLocalNotes } from "../src/client/notes-query.ts";
import { NotesStore } from "../src/client/notes-store.ts";

const note = (id, createdAt, modifiedAt) => ({
  id,
  kind: "text",
  title: id,
  body: "Body " + id,
  pinned: id === "older",
  ...(createdAt === undefined ? {} : { createdAt }),
  ...(modifiedAt === undefined ? {} : { modifiedAt }),
});
test("real persisted Notes query does not infer latest from order/pins or rewrite unknown legacy dates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-query-")),
    file = join(dir, "slots.json");
  const values = () => JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, "{}");
  const storage = {
    getItem: (key) => values()[key] ?? null,
    setItem: (key, value) =>
      writeFileSync(file, JSON.stringify({ ...values(), [key]: value })),
  };
  try {
    const legacy = JSON.stringify([
      note("older", 100, 400),
      note("newer", 200, 300),
    ]);
    storage.setItem("legacy", legacy);
    const store = new NotesStore(
        { current: "current", legacy: "legacy" },
        storage,
      ),
      before = store.raw;
    assert.deepEqual(
      queryLocalNotes(store.list, {
        kind: "latest",
        by: "created",
      }).candidates.map((n) => n.id),
      ["newer"],
    );
    assert.deepEqual(
      queryLocalNotes(store.list, {
        kind: "latest",
        by: "updated",
      }).candidates.map((n) => n.id),
      ["older"],
    );
    assert.deepEqual(
      queryLocalNotes(store.list, {
        kind: "title",
        text: " NEWER ",
      }).candidates.map((n) => n.id),
      ["newer"],
    );
    const target = await store.target("newer"),
      result = await store.execute(
        { type: "notes_read_selected", target },
        "read",
        new AbortController().signal,
        () => {},
      );
    assert.equal(result.fields.body, "Body newer");
    assert.equal(store.raw, before);
    assert.equal(storage.getItem("legacy"), legacy);
    const unknown = {
      ...note("legacy"),
      date: "2026-10-08T00:00:00.000Z",
      custom: { keep: ["all", "metadata"] },
    };
    const mixed = queryLocalNotes([note("known", 200, 200), unknown], {
      kind: "latest",
      by: "created",
    });
    assert.equal(mixed.basis, "owner-choice-uncertain");
    assert.equal(mixed.candidates.length, 2);
    assert.equal(
      queryLocalNotes([unknown], { kind: "latest", by: "updated" }).basis,
      "only-note",
    );
    assert.equal(
      queryLocalNotes(
        [
          { ...unknown, createdAt: "2026-02-31T00:00:00.000Z" },
          note("valid", 200, 200),
        ],
        { kind: "latest", by: "created" },
      ).basis,
      "owner-choice-uncertain",
    );
    assert.equal(
      queryLocalNotes(
        [
          { ...unknown, updatedAt: "2026-10-08T00:00:00.000Z" },
          note("numeric", 200, 200),
        ],
        { kind: "latest", by: "updated" },
      ).candidates[0].id,
      "legacy",
    );
    assert.equal(
      queryLocalNotes([note("a", 200, 200), note("b", 200, 200)], {
        kind: "latest",
        by: "created",
      }).basis,
      "owner-choice-uncertain",
    );
    for (const query of [
      { kind: "latest", by: "created" },
      { kind: "latest", by: "updated" },
      { kind: "title", text: "missing" },
    ])
      assert.deepEqual(queryLocalNotes([], query), {
        basis: "no-match",
        candidates: [],
        explanation: "No saved notes were found.",
      });
    assert.deepEqual(
      queryLocalNotes(store.list, { kind: "title", text: "missing" }),
      {
        basis: "no-match",
        candidates: [],
        explanation: "No saved note matches this title.",
      },
    );
    assert.equal(
      JSON.stringify(stampNoteChanges([unknown], [unknown], 999)[0]),
      JSON.stringify(unknown),
    );
    const changed = stampNoteChanges(
      [unknown],
      [{ ...unknown, body: "Actual content edit" }],
      999,
    )[0];
    assert.equal(changed.createdAt, undefined);
    assert.equal(changed.modifiedAt, 999);
    assert.deepEqual(changed.custom, unknown.custom);
    assert.equal(changed.date, unknown.date);
    const fresh = stampNoteChanges([], [note("genuinely-new")], 999)[0];
    assert.equal(fresh.createdAt, 999);
    assert.equal(fresh.modifiedAt, 999);
    assert.equal(
      stampNoteChanges(
        [fresh],
        [{ ...fresh, pinned: true, when: "Today" }],
        1000,
      )[0].modifiedAt,
      999,
    );
    store.replace([{ ...store.list[0], body: "Changed" }, store.list[1]]);
    await assert.rejects(
      store.execute(
        { type: "notes_read_selected", target: { ...target, noteId: "older" } },
        "stale",
        new AbortController().signal,
        () => {},
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
