import assert from "node:assert/strict";
import test from "node:test";
import { DocumentNotesStore } from "../src/client/notes-document-store.ts";
import {
  applyNotesDraft,
  createNotesDraftSlot,
  mergeNotesDrafts,
  notesDraftBase,
  notesDraftChanges,
  notesDraftConflicts,
  reconcileNotesEditor,
  validateNotesDraft,
} from "../src/client/notes-draft.ts";
import {
  capacityAwareNotesVault,
  isNotesStorageFull,
  NotesStorageFull,
} from "../src/client/notes-secure-store.ts";
import { NotesCommitUncertain } from "../src/client/notes-store.ts";

const note = (id, body) => ({
  id,
  kind: "text",
  title: id,
  body,
  pinned: false,
});
const saved = [note("a", "A"), note("b", "B"), note("c", "C")];

test("a draft records only edits, creations and removals", () => {
  const draft = notesDraftChanges(
    [note("new", "N"), note("a", "A edited"), note("b", "B")],
    saved,
  );
  assert.deepEqual(draft, {
    records: [note("new", "N"), note("a", "A edited")],
    added: ["new"],
    removed: ["c"],
    before: {
      a: JSON.stringify(note("a", "A")),
      c: JSON.stringify(note("c", "C")),
    },
  });
});

test("applying a draft reproduces the attempted list and is idempotent", () => {
  const attempted = [note("new", "N"), note("a", "A edited"), note("b", "B")];
  const draft = notesDraftChanges(attempted, saved);
  assert.deepEqual(applyNotesDraft(saved, draft), attempted);
  // A completed uncertain commit leaves nothing more to apply.
  assert.deepEqual(applyNotesDraft(attempted, draft), attempted);
  assert.deepEqual(notesDraftConflicts(attempted, draft), []);
});

test("newer saved edits win and a note deleted since is not revived", () => {
  const draft = notesDraftChanges(
    [note("a", "A draft"), note("b", "B"), note("c", "C"), note("n", "New")],
    saved,
  );
  const later = [note("b", "B newer"), note("c", "C")];
  assert.deepEqual(applyNotesDraft(later, draft), [
    note("n", "New"),
    note("b", "B newer"),
    note("c", "C"),
  ]);
  const same = notesDraftChanges(
    [note("a", "A draft"), note("b", "B"), note("c", "C draft")],
    saved,
  );
  const edited = [note("a", "A newer"), note("b", "B"), note("c", "C")];
  assert.deepEqual(applyNotesDraft(edited, same), [
    note("a", "A newer"),
    note("b", "B"),
    note("c", "C draft"),
  ]);
  assert.deepEqual(notesDraftConflicts(edited, same), ["a"]);
});

test("a drafted removal does not delete a note edited since", () => {
  const draft = notesDraftChanges([note("a", "A"), note("b", "B")], saved);
  const later = [note("a", "A"), note("b", "B"), note("c", "C newer")];
  assert.deepEqual(applyNotesDraft(later, draft), later);
  assert.deepEqual(notesDraftConflicts(later, draft), ["c"]);
});

test("a later failure merges a kept draft instead of replacing it", () => {
  const kept = notesDraftChanges(
    [
      note("k", "Kept new"),
      note("a", "A kept"),
      note("b", "B"),
      note("c", "C"),
    ],
    saved,
  );
  const next = notesDraftChanges(
    [note("a", "A"), note("b", "B newer"), note("c", "C")],
    saved,
  );
  assert.deepEqual(applyNotesDraft(saved, mergeNotesDrafts(kept, next)), [
    note("k", "Kept new"),
    note("a", "A kept"),
    note("b", "B newer"),
    note("c", "C"),
  ]);
  const touched = notesDraftChanges(
    [note("a", "A newest"), note("b", "B"), note("c", "C")],
    saved,
  );
  assert.deepEqual(applyNotesDraft(saved, mergeNotesDrafts(kept, touched)), [
    note("k", "Kept new"),
    note("a", "A newest"),
    note("b", "B"),
    note("c", "C"),
  ]);
});

function vault(initial = new Map()) {
  const values = new Map(initial);
  let fail = null;
  return {
    values,
    failNext(error) {
      fail = error;
    },
    async read(key) {
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async compareExchange(key, expected, value) {
      if (fail) {
        const error = fail;
        fail = null;
        throw error;
      }
      const current = values.has(key) ? values.get(key) : null;
      if (JSON.stringify(current) !== JSON.stringify(expected))
        return { status: "conflict" };
      if (value === null) values.delete(key);
      else values.set(key, structuredClone(value));
      return { status: "saved" };
    },
  };
}

test("the draft slot saves, merges kept drafts, replaces its own and clears exactly", async () => {
  const store = vault();
  const slot = createNotesDraftSlot(store, "notes-draft:v1:device", () => 42);
  const savedRaw = JSON.stringify({ version: 2, records: saved });
  assert.equal(await slot.read(), null);
  const kept = await slot.save({
    savedRaw,
    reason: "failed",
    list: [note("k", "Kept"), ...saved],
    saved,
  });
  assert.equal(kept.base, await notesDraftBase(savedRaw));
  assert.equal(kept.savedAt, 42);
  assert.deepEqual(validateNotesDraft(await slot.read()), kept);
  // Another session's kept draft is merged, never replaced.
  const merged = await slot.save({
    savedRaw,
    reason: "uncertain",
    list: [note("a", "A2"), note("b", "B"), note("c", "C")],
    saved,
  });
  assert.deepEqual(
    applyNotesDraft(saved, merged).map((n) => n.id),
    ["k", "a", "b", "c"],
  );
  // This editor's own draft is replaced, so a reverted edit is not resurrected.
  const own = await slot.save({
    savedRaw,
    reason: "uncertain",
    list: saved,
    saved,
    own: merged,
    kept: null,
  });
  assert.deepEqual(own.records, []);
  assert.equal(await slot.clear(kept), false);
  assert.equal(await slot.clear(own), true);
  assert.equal(await slot.read(), null);
  store.values.set("notes-draft:v1:device", { version: 1 });
  await assert.rejects(slot.read(), /Invalid Notes draft/);
  await assert.rejects(
    slot.save({ savedRaw, reason: "failed", list: saved, saved }),
    /Invalid Notes draft/,
  );
});

test("capacity refusals stay definite through the document engine", async () => {
  assert.equal(isNotesStorageFull({ code: "storage-full" }), true);
  assert.equal(isNotesStorageFull(Error("storage-full")), false);
  const store = vault();
  const guarded = capacityAwareNotesVault(store);
  store.failNext(Object.assign(Error("cap"), { code: "storage-full" }));
  await assert.rejects(
    guarded.compareExchange("slot", null, { a: 1 }),
    (error) =>
      error instanceof NotesStorageFull && error.code === "storage-full",
  );
  store.failNext(Error("lost"));
  await assert.rejects(guarded.compareExchange("slot", null, { a: 1 }), /lost/);
  // A definite refusal is not an uncertain commit in the shared document engine.
  let raw = null;
  const revisions = { n: 0 };
  const port = {
    async initialize(create) {
      raw = create(null, null);
      return { revision: String(++revisions.n), raw };
    },
    async read() {
      return { revision: String(revisions.n), raw };
    },
    async compareExchange() {
      throw new NotesStorageFull();
    },
  };
  const document = await DocumentNotesStore.open(port, []);
  await assert.rejects(document.replace([note("a", "A")]), (error) => {
    assert.equal(error instanceof NotesCommitUncertain, false);
    return error instanceof NotesStorageFull;
  });
});

test("only a clean editor adopts a newly committed collection", () => {
  const baseline = JSON.stringify({ version: 2, records: saved });
  const committed = [note("a", "A newer"), note("b", "B"), note("c", "C")];
  const committedRaw = JSON.stringify({ version: 2, records: committed });
  assert.deepEqual(reconcileNotesEditor(baseline, saved, baseline, saved), {
    kind: "unchanged",
  });
  assert.deepEqual(
    reconcileNotesEditor(baseline, saved, committedRaw, committed),
    { kind: "refresh", list: committed },
  );
  assert.deepEqual(
    reconcileNotesEditor(baseline, committed, committedRaw, committed),
    { kind: "refresh" },
  );
  assert.deepEqual(
    reconcileNotesEditor(
      baseline,
      [note("a", "unsaved"), note("b", "B"), note("c", "C")],
      committedRaw,
      committed,
    ),
    { kind: "conflict" },
  );
  assert.deepEqual(
    reconcileNotesEditor("not json", saved, committedRaw, committed),
    { kind: "conflict" },
  );
});
