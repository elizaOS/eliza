import assert from "node:assert/strict";
import test from "node:test";
import { NotesStore } from "../src/client/notes-store.ts";

function makeStore(records) {
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
    records,
    deleted: [],
  };
  storage.setItem("current", JSON.stringify(envelope));
  return new NotesStore({ current: "current", legacy: "legacy" }, storage);
}

test("notes_read_selected succeeds for a body-less note (missing property)", async () => {
  const store = makeStore([{ id: "n1", kind: "text", title: "No body" }]);
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

test("notes_read_selected rejects a note whose body is null", async () => {
  const store = makeStore([
    { id: "n2", kind: "text", title: "Null body", body: null },
  ]);
  const target = await store.target("n2");
  const ac = new AbortController();

  await assert.rejects(
    () =>
      store.execute(
        { type: "notes_read_selected", target },
        "op-2",
        ac.signal,
        () => {},
      ),
    /Invalid Notes text/,
  );
});
