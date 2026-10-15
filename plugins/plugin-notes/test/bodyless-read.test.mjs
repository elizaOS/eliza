import assert from "node:assert/strict";
import test from "node:test";
import { NotesStore } from "../src/client/notes-store.ts";

test("notes_read_selected succeeds for a body-less note", async () => {
  const data = {};
  const storage = {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
  const envelope = {
    version: 2,
    collectionId: "00000000-0000-0000-0000-000000000001",
    records: [{ id: "n1", kind: "text", title: "No body" }],
    deleted: [],
  };
  storage.setItem("current", JSON.stringify(envelope));

  const store = new NotesStore(
    { current: "current", legacy: "legacy" },
    storage,
  );
  const target = await store.target("n1");
  const ac = new AbortController();

  const result = await store.execute(
    { type: "notes_read_selected", target },
    "op-1",
    ac.signal,
    () => {},
  );

  assert.equal(result.fields.title, "No body");
  assert.equal(result.fields.body, "");
});
