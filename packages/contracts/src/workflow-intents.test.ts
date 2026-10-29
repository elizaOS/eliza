import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyWorkflowIntentArchive,
  storageWorkflowIntentBackend,
  type WorkflowIntentArchive,
  type WorkflowIntentBackend,
  WorkflowIntentConflict,
  WorkflowIntentStore,
  workflowIntentKey,
  workflowIntentOwnerPrefix,
} from "./workflow-intents.ts";

const owner = {
  origin: "https://agent.example",
  ownerId: "owner-1",
  agentId: "agent-1",
};
const other = { ...owner, ownerId: "owner-2" };

function memoryBackend(): WorkflowIntentBackend & {
  archive: WorkflowIntentArchive;
} {
  const backend = {
    archive: emptyWorkflowIntentArchive(),
    async read() {
      return structuredClone(backend.archive);
    },
    async edit(update: (archive: WorkflowIntentArchive) => void) {
      const next = structuredClone(backend.archive);
      update(next);
      backend.archive = next;
    },
  };
  return backend;
}
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("keys carry the installed prefix and the captured owner", () => {
  assert.equal(
    workflowIntentKey(owner, "wf-1:run", "alpha.workflow.pending.v1:"),
    'alpha.workflow.pending.v1:["https://agent.example","owner-1","agent-1","wf-1:run"]',
  );
  assert.ok(
    workflowIntentKey(owner, "x").startsWith(workflowIntentOwnerPrefix(owner)),
  );
  assert.equal(
    workflowIntentKey(other, "x").startsWith(workflowIntentOwnerPrefix(owner)),
    false,
  );
});

test("an intent is admitted once, locks its key and is cleared only at its revision", async () => {
  let changes = 0;
  const backend = memoryBackend();
  const store = new WorkflowIntentStore(owner, {
    keyPrefix: "alpha.workflow.pending.v1:",
    backend,
    onChange: () => changes++,
  });
  const key = store.key(owner, "wf-1:run");
  // No snapshot yet: every key reads as locked.
  assert.equal(store.stale, true);
  assert.equal(store.locked(key), true);
  await store.load();
  assert.equal(store.locked(key), false);
  const raw = await store.admit(key, { kind: "run", submissionId: "s-1" });
  assert.equal(JSON.parse(raw).submissionId, "s-1");
  assert.equal(typeof JSON.parse(raw).intentRevision, "string");
  assert.equal(store.locked(key), true);
  await assert.rejects(
    store.admit(key, { kind: "run" }),
    WorkflowIntentConflict,
  );
  // A failed write drops the snapshot so the key stays locked until reload.
  assert.equal(store.stale, true);
  await store.load();
  await assert.rejects(
    store.acknowledge(key, `${raw} `),
    WorkflowIntentConflict,
  );
  await store.load();
  await store.acknowledge(key, raw);
  assert.equal(store.locked(key), false);
  assert.equal(await store.read(key), null);
  assert.equal(changes, 2);
});

test("another owner's keys and stored entries are refused", async () => {
  const backend = memoryBackend();
  const store = new WorkflowIntentStore(owner, { backend });
  assert.throws(() => store.key(other, "x"), /another agent/);
  assert.throws(
    () => store.locked(workflowIntentKey(other, "x")),
    /another agent/,
  );
  backend.archive.entries[workflowIntentKey(other, "x")] = "{}";
  await assert.rejects(store.load(), /another agent/);
  backend.archive = {
    entries: {},
    extra: true,
  } as unknown as WorkflowIntentArchive;
  await assert.rejects(store.load(), /needs recovery/);
});

test("pending lifecycle changes are listed by workflow", async () => {
  const backend = memoryBackend();
  const store = new WorkflowIntentStore(owner, { keyPrefix: "p:", backend });
  await store.load();
  await store.admit(`${store.key(owner, "wf-1")}:lifecycle`, { kind: "pause" });
  await store.admit(`${store.key(owner, "wf-2")}:metadata`, { kind: "rename" });
  assert.deepEqual(store.pendingLifecycle(), ["wf-1"]);
});

test("the storage backend keeps one installed slot per key and ignores other owners", async () => {
  const storage = new MemoryStorage();
  const prefix = "alpha.workflow.pending.v1:";
  storage.setItem(workflowIntentKey(other, "x", prefix), "other");
  storage.setItem("unrelated", "1");
  const store = new WorkflowIntentStore(owner, {
    keyPrefix: prefix,
    backend: storageWorkflowIntentBackend(
      storage,
      workflowIntentOwnerPrefix(owner, prefix),
    ),
  });
  await store.load();
  const key = store.key(owner, "wf-1:run");
  const raw = await store.admit(key, { kind: "run" });
  assert.equal(storage.getItem(key), raw);
  await store.acknowledge(key, raw);
  assert.equal(storage.getItem(key), null);
  assert.equal(storage.getItem(workflowIntentKey(other, "x", prefix)), "other");
  assert.equal(storage.getItem("unrelated"), "1");
});
