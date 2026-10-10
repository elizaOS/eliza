import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindingKind,
  filterEntries,
  normalizeWebsite,
} from "../src/bindings.ts";
import {
  assertNoSecretFields,
  createPasswordsClient,
  parseEntries,
  passwordsError,
} from "../src/client.ts";

const SYNTHETIC = "synthetic-value-not-a-secret";
const entry = (id, label, username, facets) => ({
  id,
  label,
  username,
  updatedAt: 1,
  bindings: facets.map((facet) => ({
    kind: facet.startsWith("android://") ? "android" : "web",
    facet,
    display: facet.replace(/^https:\/\//, ""),
  })),
});

test("website input normalizes to the same exact origin as native code", () => {
  assert.equal(normalizeWebsite("Example.COM"), "https://example.com");
  assert.equal(
    normalizeWebsite("https://example.com/login?next=1#x"),
    "https://example.com",
  );
  assert.equal(
    normalizeWebsite("https://example.com:443/"),
    "https://example.com",
  );
  assert.equal(
    normalizeWebsite("https://example.com:8443"),
    "https://example.com:8443",
  );
  assert.equal(
    normalizeWebsite("https://bücher.example"),
    "https://xn--bcher-kva.example",
  );
  assert.equal(normalizeWebsite("example.com."), "https://example.com");
  for (const bad of [
    "",
    "http://example.com",
    "https://user:pw@example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://exa_mple.com",
    "ftp://example.com",
  ]) {
    assert.throws(() => normalizeWebsite(bad), { code: "invalid" }, bad);
  }
  assert.equal(bindingKind("https://example.com"), "web");
  assert.equal(
    bindingKind(`android://${"ab".repeat(32)}@com.example.app`),
    "android",
  );
  assert.equal(bindingKind("https://example.com/path"), null);
});

test("search matches label, username and bindings without reordering instability", () => {
  const entries = [
    entry("2", "Zeta", "z@example.test", ["https://zeta.example"]),
    entry("1", "Alpha bank", "a@example.test", [
      `android://${"ab".repeat(32)}@com.example.bank`,
    ]),
  ];
  assert.deepEqual(
    filterEntries(entries, "").map((e) => e.id),
    ["1", "2"],
  );
  assert.deepEqual(
    filterEntries(entries, "ZETA.EX").map((e) => e.id),
    ["2"],
  );
  assert.deepEqual(
    filterEntries(entries, "com.example.bank").map((e) => e.id),
    ["1"],
  );
  assert.deepEqual(
    filterEntries(entries, "a@ex").map((e) => e.id),
    ["1"],
  );
  assert.deepEqual(filterEntries(entries, "nothing"), []);
});

test("no bridge response may carry a secret-like field at any depth", () => {
  for (const key of [
    "password",
    "Password",
    "otp_secret",
    "passkey",
    "privateKey",
    "secret",
    "TOTP",
    "credentials",
  ]) {
    assert.throws(
      () =>
        assertNoSecretFields({
          entries: [{ id: "1", nested: { [key]: SYNTHETIC } }],
        }),
      { code: "unavailable" },
      key,
    );
  }
  assert.doesNotThrow(() =>
    assertNoSecretFields({
      entries: [entry("1", "Example", "user", ["https://example.com"])],
    }),
  );
  // Parsed entries are rebuilt from allowlisted fields; unknown keys are dropped.
  const [parsed] = parseEntries({
    entries: [
      {
        ...entry("1", "Example", "user", ["https://example.com"]),
        note: SYNTHETIC,
      },
    ],
  });
  assert.equal(JSON.stringify(parsed).includes(SYNTHETIC), false);
  assert.deepEqual(Object.keys(parsed).sort(), [
    "bindings",
    "id",
    "label",
    "updatedAt",
    "username",
  ]);
});

test("client rejects leaking native responses and maps errors without echoing input", async () => {
  const calls = [];
  const leaking = {
    async status() {
      return {
        available: true,
        locked: false,
        unlockRemainingMs: 1000,
        unlockSeconds: 60,
        biometric: true,
        autofill: { supported: true, selected: "this-app" },
      };
    },
    async unlock() {
      return { unlocked: true, unlockRemainingMs: 5 };
    },
    async lock() {
      return { locked: true };
    },
    async list() {
      return {
        entries: [
          {
            ...entry("1", "Example", "user", ["https://example.com"]),
            password: SYNTHETIC,
          },
        ],
      };
    },
    async save(input) {
      calls.push(input);
      return { id: "new", generated: true, length: 20 };
    },
    async remove() {
      return { removed: true };
    },
    async reset() {
      return { reset: true, credential: SYNTHETIC };
    },
    async reveal() {
      return {
        shown: true,
        hidesAfterMs: 30000,
        value: SYNTHETIC,
        password: SYNTHETIC,
      };
    },
    async copy() {
      throw Object.assign(new Error(`failed for ${SYNTHETIC}`), {
        code: "weird",
      });
    },
    async openAutofillSettings() {
      return { status: "opened", destination: "autofill-picker" };
    },
  };
  const client = createPasswordsClient(leaking);
  assert.deepEqual(await client.status(), {
    available: true,
    locked: false,
    unlockRemainingMs: 1000,
    unlockSeconds: 60,
    biometric: true,
    autofill: { supported: true, selected: "this-app" },
  });
  await assert.rejects(
    client.list(),
    (error) =>
      error.code === "unavailable" && !error.message.includes(SYNTHETIC),
  );
  await assert.rejects(
    client.reveal("1"),
    (error) =>
      error.code === "unavailable" && !error.message.includes(SYNTHETIC),
  );
  await assert.rejects(
    client.copy("1"),
    (error) =>
      error.code === "unavailable" && !error.message.includes(SYNTHETIC),
  );
  assert.deepEqual(
    await client.save({
      label: "Example",
      username: "user",
      websites: ["https://example.com"],
      generate: { length: 20 },
    }),
    { id: "new", generated: true, length: 20 },
  );
  await assert.rejects(
    client.save({
      label: "x",
      username: "",
      websites: [],
      password: "a",
      generate: {},
    }),
    { code: "invalid" },
  );
  await assert.rejects(
    client.reset(),
    (error) =>
      error.code === "unavailable" && !error.message.includes(SYNTHETIC),
  );
  const resetting = createPasswordsClient({
    ...leaking,
    async reset() {
      return { reset: true };
    },
  });
  assert.equal(await resetting.reset(), undefined);
  await assert.rejects(
    createPasswordsClient({
      ...leaking,
      async reset() {
        return { reset: false };
      },
    }).reset(),
    { code: "unavailable" },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(await client.openAutofillSettings(), {
    destination: "autofill-picker",
  });
  assert.equal(
    passwordsError({ code: "invalid", message: "Enter a name" }).message,
    "Enter a name",
  );
  assert.equal(
    passwordsError({ code: "invalid", message: `value ${SYNTHETIC}: bad` })
      .message,
    "Check the entry and try again.",
  );
  assert.equal(
    passwordsError({ code: "locked", message: SYNTHETIC }).message,
    "Unlock saved passwords first.",
  );
});
