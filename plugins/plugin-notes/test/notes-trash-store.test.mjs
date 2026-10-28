import assert from "node:assert/strict";
import test from "node:test";
import { createNotesTrashPolicy } from "../src/client/notes-trash-policy.ts";
import {
  compareExchangeNotesTrashPort,
  createNotesTrashStore,
  NotesTrashChanged,
  NotesTrashUnconfirmed,
} from "../src/client/notes-trash-store.ts";

const DAY = 24 * 60 * 60 * 1000;
const policy = createNotesTrashPolicy({
  retentionMs: 3 * DAY,
  maxEntries: 10,
  maxBytes: 1024 * 1024,
  kinds: ["text"],
});
const row = (id) => ({
  id,
  note: { id: `note-${id}`, kind: "text", title: id },
  index: 0,
  deletedAt: Date.UTC(2026, 9, 28),
});

function slot(initial = null) {
  const state = { value: initial, exchanges: 0 };
  return {
    state,
    read: async () => structuredClone(state.value),
    async compareExchange(expected, next) {
      state.exchanges++;
      if (JSON.stringify(expected) !== JSON.stringify(state.value))
        return false;
      state.value = structuredClone(next);
      return true;
    },
  };
}

test("a missing slot reads as an empty Trash and an edit is written then confirmed", async () => {
  const s = slot();
  const store = createNotesTrashStore(policy, compareExchangeNotesTrashPort(s));
  assert.deepEqual(await store.read(), { version: 1, entries: [] });
  const written = await store.edit((doc) => policy.add(doc, row("a")));
  assert.deepEqual(
    written.entries.map((e) => e.id),
    ["a"],
  );
  assert.deepEqual(s.state.value, written);
});

test("a concurrent write between read and exchange is refused and nothing is overwritten", async () => {
  const s = slot({ version: 1, entries: [row("a")] });
  const store = createNotesTrashStore(policy, compareExchangeNotesTrashPort(s));
  await assert.rejects(
    store.edit((doc) => {
      s.state.value = { version: 1, entries: [row("other")] };
      return policy.add(doc, row("b"));
    }),
    NotesTrashChanged,
  );
  assert.deepEqual(
    s.state.value.entries.map((e) => e.id),
    ["other"],
  );
});

test("invalid input or output is refused before anything is written", async () => {
  const bad = slot({ version: 2, entries: [] });
  await assert.rejects(
    createNotesTrashStore(policy, compareExchangeNotesTrashPort(bad)).edit(
      (d) => d,
    ),
    /Invalid Notes Trash/,
  );
  assert.equal(bad.state.exchanges, 0);
  const s = slot();
  await assert.rejects(
    createNotesTrashStore(policy, compareExchangeNotesTrashPort(s)).edit(
      () => ({
        version: 1,
        entries: [{ id: "x" }],
      }),
    ),
  );
  assert.equal(s.state.exchanges, 0);
});

test("a write the store does not read back is reported as unconfirmed", async () => {
  const stored = null;
  const port = {
    read: async () => stored,
    async edit(update) {
      update(stored); // accepted, but never persisted
    },
  };
  await assert.rejects(
    createNotesTrashStore(policy, port).edit((doc) =>
      policy.add(doc, row("a")),
    ),
    NotesTrashUnconfirmed,
  );
  const silent = { read: async () => null, async edit() {} };
  await assert.rejects(
    createNotesTrashStore(policy, silent).edit((doc) => doc),
    NotesTrashUnconfirmed,
  );
});

test("a host edit that retries keeps the last validated value", async () => {
  let stored = { version: 1, entries: [row("a")] };
  const port = {
    read: async () => structuredClone(stored),
    async edit(update) {
      update({ version: 1, entries: [] });
      stored = structuredClone(update(stored));
    },
  };
  const written = await createNotesTrashStore(policy, port).edit((doc) =>
    policy.add(doc, row("b")),
  );
  assert.deepEqual(written.entries.map((e) => e.id).sort(), ["a", "b"]);
});
