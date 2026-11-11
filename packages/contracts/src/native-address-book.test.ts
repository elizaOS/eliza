import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AddressBookUnavailable,
  CONTACT_EMAIL_TYPES,
  CONTACT_PHONE_TYPES,
  type ContactDraft,
  contactDraftProblem,
  createAddressBookClient,
  isIncompleteAddressBookContact,
  parseAddressBookPage,
  parseAddressBookStatus,
  parseContactDetail,
  parseContactRemove,
  parseContactSave,
} from "./native-address-book.ts";

type Call = [string, unknown];
function stub(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const plugin = new Proxy(
    {},
    {
      get: (_, method: string) =>
        method === "then"
          ? undefined
          : async (options: unknown) => {
              calls.push([method, options]);
              const answer = answers[method];
              if (answer instanceof Error) throw answer;
              return answer;
            },
    },
  );
  // biome-ignore lint/suspicious/noExplicitAny: recording stub of the native bridge
  return { plugin: plugin as any, calls };
}
const VERSION = "a".repeat(64);
const NEXT = "b".repeat(64);
const detail = (patch: Record<string, unknown> = {}) => ({
  id: "101",
  lookup: "key101",
  displayName: "Ada Lovelace",
  starred: false,
  phoneNumbers: [
    { number: "+1 (555) 555-0100", type: "mobile" },
    { number: "5550101", type: "custom:Boat" },
  ],
  emailAddresses: [{ address: "ada@example.test", type: "work" }],
  version: VERSION,
  ...patch,
});
const draft = (patch: Partial<ContactDraft> = {}): ContactDraft => ({
  displayName: "Ada Lovelace",
  phoneNumbers: [{ number: "5550100", type: "mobile" }],
  emailAddresses: [],
  ...patch,
});

test("status never reports more access than it has", () => {
  assert.deepEqual(
    parseAddressBookStatus({ available: true, readable: true, writable: true }),
    { available: true, readable: true, writable: true },
  );
  // A host built before in-app editing reports no `writable`: it cannot write.
  assert.deepEqual(
    parseAddressBookStatus({ available: true, readable: true }),
    {
      available: true,
      readable: true,
      writable: false,
    },
  );
  for (const bad of [
    { available: false, readable: true },
    { available: true, readable: false, writable: true },
    { available: true, readable: "yes" },
    { readable: true },
    null,
  ])
    assert.throws(() => parseAddressBookStatus(bad), /invalid/);
});

test("list pages are bounded and keep a contact the host refused to clip", async () => {
  const row = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    lookup: `key${id}`,
    name: "Ada",
    revision: "1700000000000",
    starred: false,
    phones: ["5550100"],
    emails: [],
    ...patch,
  });
  const page = {
    contacts: [
      row("1"),
      { id: "2", incomplete: true, reason: "too-many-fields" },
    ],
    more: true,
    next: "v1.2.2.",
  };
  const { plugin, calls } = stub({ list: page });
  const client = createAddressBookClient(plugin);
  const parsed = await client.list("ad", 2);
  assert.equal(parsed.next, "v1.2.2.");
  assert.equal(isIncompleteAddressBookContact(parsed.contacts[0]), false);
  assert.deepEqual(parsed.contacts[1], {
    id: "2",
    incomplete: true,
    reason: "too-many-fields",
  });
  await client.list("ad", 2, "v1.2.2.");
  assert.deepEqual(calls, [
    ["list", { query: "ad", limit: 2 }],
    ["list", { query: "ad", limit: 2, cursor: "v1.2.2." }],
  ]);
  await assert.rejects(client.list("x".repeat(129)), RangeError);
  await assert.rejects(client.list("", 201), RangeError);
  await assert.rejects(client.list("", 50, ""), RangeError);
  assert.equal(calls.length, 2);

  assert.deepEqual(parseAddressBookPage({ contacts: [], more: false }, 50), {
    contacts: [],
    next: null,
  });
  for (const bad of [
    { contacts: [row("1"), row("2"), row("3")], more: false },
    { contacts: [row("1"), row("1")], more: false },
    { contacts: [row("1")], more: true },
    { contacts: [row("1")], more: false, next: "v1.1.1." },
    { contacts: [], more: true, next: "v1.1.1." },
    { contacts: [row("01")], more: false },
    { contacts: [row("1", { phones: Array(33).fill("5") })], more: false },
    { contacts: [row("1", { name: "x".repeat(1025) })], more: false },
    {
      contacts: [{ id: "2", incomplete: true, reason: "shy", name: "Ada" }],
      more: false,
    },
    {
      contacts: [{ id: "2", incomplete: true, reason: "private" }],
      more: false,
    },
    { contacts: [row("1")] },
  ])
    assert.throws(() => parseAddressBookPage(bad, 2), /invalid/);
});

test("a contact read for editing has typed fields and a version", async () => {
  const { plugin, calls } = stub({ get: detail() });
  const client = createAddressBookClient(plugin);
  assert.deepEqual(await client.get("101"), detail());
  assert.deepEqual(calls, [["get", { id: "101" }]]);
  await assert.rejects(client.get("0"), RangeError);
  assert.equal(calls.length, 1);

  for (const type of CONTACT_PHONE_TYPES)
    parseContactDetail(
      detail({ phoneNumbers: [{ number: "5550100", type }] }),
      "101",
    );
  for (const type of CONTACT_EMAIL_TYPES)
    parseContactDetail(
      detail({ emailAddresses: [{ address: "a@example.test", type }] }),
      "101",
    );
  for (const bad of [
    detail({ id: "102" }),
    detail({ version: "1" }),
    detail({ version: undefined }),
    detail({ photo: "content://contacts/1/photo" }),
    detail({ phoneNumbers: [{ number: "5550100", type: "satellite" }] }),
    detail({ phoneNumbers: [{ number: "5550100", type: "custom:" }] }),
    detail({ phoneNumbers: [{ number: " ", type: "home" }] }),
    detail({ phoneNumbers: [{ number: "5550100" }] }),
    detail({ phoneNumbers: [{ number: "5550100", type: "home", primary: 1 }] }),
    detail({ phoneNumbers: ["5550100"] }),
    detail({ emailAddresses: [{ address: "a@example.test", type: "pager" }] }),
    detail({
      phoneNumbers: Array(33).fill({ number: "5550100", type: "home" }),
    }),
    detail({ displayName: "x".repeat(257) }),
  ])
    assert.throws(() => parseContactDetail(bad, "101"), /invalid/);
});

test("a draft is checked as given, before anything reaches the phone", () => {
  assert.equal(contactDraftProblem(draft()), null);
  assert.equal(
    contactDraftProblem(draft({ displayName: "", phoneNumbers: [] })),
    "empty-contact",
  );
  assert.equal(
    contactDraftProblem(draft({ displayName: "" })),
    null,
    "a number alone is a contact",
  );
  assert.equal(
    contactDraftProblem(draft({ displayName: " " })),
    "invalid-name",
  );
  assert.equal(
    contactDraftProblem(draft({ displayName: "Ada\u0007" })),
    "invalid-name",
  );
  assert.equal(
    contactDraftProblem(draft({ displayName: "x".repeat(257) })),
    "invalid-name",
  );
  assert.equal(
    contactDraftProblem(
      draft({ phoneNumbers: [{ number: "", type: "mobile" }] }),
    ),
    "invalid-number",
  );
  assert.equal(
    contactDraftProblem(
      draft({ phoneNumbers: [{ number: "5".repeat(65), type: "mobile" }] }),
    ),
    "invalid-number",
  );
  assert.equal(
    contactDraftProblem(
      draft({ phoneNumbers: [{ number: "5550100", type: "Mobile" }] }),
    ),
    "invalid-type",
  );
  assert.equal(
    contactDraftProblem(
      draft({ emailAddresses: [{ address: " ", type: "home" }] }),
    ),
    "invalid-address",
  );
  assert.equal(
    contactDraftProblem(
      draft({
        phoneNumbers: Array(33).fill({ number: "5550100", type: "home" }),
      }),
    ),
    "too-many-fields",
  );
});

test("saves name the version that was read; a changed contact is stale, not overwritten", async () => {
  const { plugin, calls } = stub({
    save: { status: "saved", id: "101", version: NEXT },
  });
  const client = createAddressBookClient(plugin);
  assert.deepEqual(await client.updateContact("101", VERSION, draft()), {
    status: "saved",
    id: "101",
    version: NEXT,
  });
  assert.deepEqual(await client.createContact(draft()), {
    status: "saved",
    id: "101",
    version: NEXT,
  });
  assert.deepEqual(calls, [
    [
      "save",
      {
        id: "101",
        version: VERSION,
        displayName: "Ada Lovelace",
        phoneNumbers: [{ number: "5550100", type: "mobile" }],
        emailAddresses: [],
      },
    ],
    [
      "save",
      {
        displayName: "Ada Lovelace",
        phoneNumbers: [{ number: "5550100", type: "mobile" }],
        emailAddresses: [],
      },
    ],
  ]);
  await assert.rejects(client.updateContact("101", "old", draft()), RangeError);
  await assert.rejects(
    client.updateContact("101", VERSION, draft({ displayName: " " })),
    /invalid-name/,
  );
  await assert.rejects(
    client.createContact(draft({ displayName: "", phoneNumbers: [] })),
    /empty-contact/,
  );
  assert.equal(calls.length, 2, "an invalid save never reaches native");

  for (const status of ["stale", "not-found", "failed", "unknown"])
    assert.deepEqual(parseContactSave({ status }, "101"), { status });
  assert.deepEqual(parseContactSave({ status: "unknown" }), {
    status: "unknown",
  });
  assert.deepEqual(parseContactSave({ status: "failed" }), {
    status: "failed",
  });
  assert.deepEqual(
    parseContactSave({ status: "saved", id: null, version: null }, "101"),
    { status: "saved", id: null, version: null },
  );
  for (const bad of [
    { status: "saved" },
    { status: "saved", id: "101", version: null },
    { status: "saved", id: null, version: NEXT },
    { status: "saved", id: "101", version: "2" },
    { status: "saved", id: "x", version: NEXT },
    { status: "stale", id: "101", version: NEXT },
    { status: "updated" },
  ])
    assert.throws(() => parseContactSave(bad, "101"), /invalid/);
  // A new contact cannot be stale or missing.
  assert.throws(() => parseContactSave({ status: "stale" }), /invalid/);
  assert.throws(() => parseContactSave({ status: "not-found" }), /invalid/);

  const stale = createAddressBookClient(
    stub({ save: { status: "stale" } }).plugin,
  );
  assert.deepEqual(await stale.updateContact("101", VERSION, draft()), {
    status: "stale",
  });
});

test("removal names the version; refusals are typed and old hosts are unavailable", async () => {
  const { plugin, calls } = stub({ remove: { status: "deleted" } });
  const client = createAddressBookClient(plugin);
  assert.deepEqual(await client.remove("101", VERSION), { status: "deleted" });
  assert.deepEqual(calls, [["remove", { id: "101", version: VERSION }]]);
  await assert.rejects(client.remove("101", ""), RangeError);
  assert.equal(calls.length, 1);
  for (const status of ["stale", "not-found", "failed", "unknown"])
    assert.deepEqual(parseContactRemove({ status }), { status });
  assert.throws(() => parseContactRemove({ status: "saved" }), /invalid/);
  assert.throws(
    () => parseContactRemove({ status: "deleted", count: 2 }),
    /invalid/,
  );

  // A missing WRITE_CONTACTS grant is the native side's typed rejection, passed through unchanged.
  const denied = Object.assign(
    new Error("Contacts write access is not granted"),
    {
      code: "permission-required",
    },
  );
  await assert.rejects(
    createAddressBookClient(stub({ remove: denied }).plugin).remove(
      "101",
      VERSION,
    ),
    (error: unknown) => error === denied,
  );
  // A host built before the in-app editor has no such methods; the handoff methods still work.
  const old = createAddressBookClient({
    status: async () => ({ available: true, readable: true }),
    requestPermissions: async () => ({ available: true, readable: true }),
    list: async () => ({ contacts: [], more: false }),
    create: async () => ({ status: "returned" }),
    edit: async () => ({ status: "returned" }),
  });
  await assert.rejects(old.get("101"), AddressBookUnavailable);
  await assert.rejects(old.createContact(draft()), AddressBookUnavailable);
  await assert.rejects(old.remove("101", VERSION), AddressBookUnavailable);
  await old.create();
  assert.equal((await old.status()).writable, false);
  await assert.rejects(
    createAddressBookClient(null).status(),
    AddressBookUnavailable,
  );
});
