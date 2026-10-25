import assert from "node:assert/strict";
import test from "node:test";
import { createManualActivity } from "./manual-activity.mjs";

const binding = {
  tabId: "1",
  actorId: "actor",
  accountId: "account",
  agentId: "agent",
  taskId: "task",
  epoch: 0,
  bindingRevision: 1,
  origin: "https://example.test",
  expiresAt: Date.now() + 60000,
  revoked: false,
};
const sender = {
  id: "extension",
  tab: { id: 1 },
  frameId: 0,
  documentId: "document",
  url: "https://example.test/form?secret=value",
};
const message = {
  type: "task-manual-activity",
  kind: "form-submit",
  bindingRevision: 1,
  eventId: "11111111-1111-4111-8111-111111111111",
};
function fixture() {
  const records = {};
  let current = { ...binding };
  const api = {
    runtime: { id: "extension" },
    storage: {
      local: {
        get: async (key) => ({ [key]: records[key] }),
        set: async (value) => Object.assign(records, structuredClone(value)),
      },
    },
  };
  return {
    records,
    api,
    get: () => current,
    set: (value) => {
      current = value;
    },
    journal: createManualActivity(api, () => current),
  };
}
test("manual activity is durable, deduplicated and excludes page contents", async () => {
  const f = fixture();
  await f.journal.record(message, sender);
  await f.journal.record(message, sender);
  const recreated = createManualActivity(f.api, f.get);
  const result = await recreated.read(binding);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, "form-submit");
  assert.equal(result.events[0].origin, binding.origin);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(
    (await recreated.read({ ...binding, accountId: "other" })).events.length,
    0,
  );
  assert.equal(
    (await recreated.read({ ...binding, epoch: 1 })).events.length,
    1,
    "same task retains events after epoch change",
  );
});
test("foreign frames, origins, extensions, stale scopes and extra data are refused", async () => {
  const f = fixture();
  for (const invalid of [
    { ...sender, frameId: 1 },
    { ...sender, id: "other" },
    { ...sender, url: "https://other.test" },
    { ...sender, documentId: "" },
  ])
    await assert.rejects(f.journal.record(message, invalid));
  for (const invalid of [
    { ...message, bindingRevision: 0 },
    { ...message, password: "secret" },
    { ...message, kind: "success" },
  ])
    await assert.rejects(f.journal.record(invalid, sender));
  f.set({ ...binding, revoked: true });
  await assert.rejects(f.journal.record(message, sender));
  assert.equal((await f.journal.read(binding)).events.length, 0);
});
test("storage errors are not acknowledged and overflow is explicit", async () => {
  const f = fixture();
  const set = f.api.storage.local.set;
  f.api.storage.local.set = async () => {
    throw new Error("disk");
  };
  await assert.rejects(f.journal.record(message, sender), /disk/);
  f.api.storage.local.set = set;
  for (let i = 0; i < 257; i++)
    await f.journal.record(
      {
        ...message,
        eventId: `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`,
      },
      sender,
    );
  const result = await f.journal.read(binding);
  assert.equal(result.events.length, 256);
  assert.equal(result.overflow, true);
});
