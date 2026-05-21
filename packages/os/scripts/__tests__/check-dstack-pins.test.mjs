// OS-4 dstack-pins-check tests.
// Runner: node --test (bun test segfaults on the OS lane in this environment).
//   node --test packages/os/scripts/__tests__/check-dstack-pins.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { checkDstackPins } from "../check-dstack-pins.mjs";
import { readJson, repoRoot } from "../os-release-lib.mjs";

const pinsPath = path.join(
  repoRoot,
  "packages/os/linux/confidential/dstack-pins.json",
);
const schemaPath = path.join(
  repoRoot,
  "packages/os/release/schema/dstack-pins.schema.json",
);

async function load() {
  return {
    pins: await readJson(pinsPath),
    schema: await readJson(schemaPath),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// A confirmed copy: the shipped data is intentionally unconfirmed (OPEN owner
// decision §8.3), so confirming the pin is the only way to reach a PASS and lets
// the other invariants be exercised independently of the pin gate.
function confirmed(pins) {
  const copy = clone(pins);
  copy.pinnedRelease.confirmed = true;
  copy.pinnedRelease.tag = "v0.5.3-secure-by-default";
  return copy;
}

test("shipped dstack pins are BLOCKED fail-closed (unconfirmed pin)", async () => {
  const { pins, schema } = await load();
  const result = checkDstackPins(pins, schema);
  assert.equal(result.ok, false, "an unconfirmed pin must not pass");
  assert.equal(result.blocked, true, "the sole failure is the unconfirmed pin");
  assert.ok(
    result.errors.some((e) => e.includes("UNCONFIRMED")),
    result.errors.join("\n"),
  );
});

test("a confirmed, fully-hardened pin set passes", async () => {
  const { pins, schema } = await load();
  const result = checkDstackPins(confirmed(pins), schema);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("tag set but confirmed=false is still BLOCKED", async () => {
  const { pins, schema } = await load();
  const tagged = clone(pins);
  tagged.pinnedRelease.tag = "v0.5.3";
  tagged.pinnedRelease.confirmed = false;
  const result = checkDstackPins(tagged, schema);
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
});

test("a forbidden weakness class left unforbidden is a hard FAIL (not blocked)", async () => {
  const { pins, schema } = await load();
  const broken = confirmed(pins);
  broken.forbid.devMode = false;
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false);
  assert.ok(
    result.errors.some((e) => e.includes("forbid.devMode must be true")),
  );
});

test("a missing required hardening is a hard FAIL", async () => {
  const { pins, schema } = await load();
  const broken = confirmed(pins);
  broken.require.tlsVerify = false;
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("require.tlsVerify must be true")),
  );
});

test("a missing required production claim is a hard FAIL", async () => {
  const { pins, schema } = await load();
  const broken = confirmed(pins);
  broken.requiredClaims.debugDisabled = false;
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("requiredClaims.debugDisabled")),
  );
});

test("rooting trust solely in dstack-KMS is rejected", async () => {
  const { pins, schema } = await load();
  const broken = confirmed(pins);
  broken.rootOfTrust.anchor = "dstack-kms";
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("must NOT be solely dstack-KMS")),
  );
});

test("dstack-KMS as the default verifier is rejected", async () => {
  const { pins, schema } = await load();
  const broken = confirmed(pins);
  broken.rootOfTrust.defaultVerifier = "dstack-kms";
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) =>
      e.includes("defaultVerifier must NOT be dstack-KMS"),
    ),
  );
});

test("a confirmed pin with a hard failure is not classified as blocked", async () => {
  const { pins, schema } = await load();
  const broken = clone(pins);
  // unconfirmed AND a hard failure -> not "blocked-only"
  broken.forbid.devKms = false;
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false);
});

test("a structurally malformed pin set is rejected by the schema", async () => {
  const { pins, schema } = await load();
  const broken = clone(pins);
  delete broken.forbid;
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});

test("a malformed appAuth code hash is rejected by the schema", async () => {
  const { pins, schema } = await load();
  const broken = confirmed(pins);
  broken.appAuthAllowlist.codeHashes = ["not-a-digest"];
  const result = checkDstackPins(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});
