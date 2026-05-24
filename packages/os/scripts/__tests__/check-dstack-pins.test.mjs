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
const manifestPath = path.join(
  repoRoot,
  "packages/os/release/confidential-2026-05-21/manifest.json",
);

async function load() {
  return {
    pins: await readJson(pinsPath),
    schema: await readJson(schemaPath),
    manifest: await readJson(manifestPath),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("shipped track-latest pins PASS (owner decision §8.3)", async () => {
  const { pins, schema, manifest } = await load();
  const result = checkDstackPins(pins, schema, manifest);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.blocked, false);
});

test("track-latest is a valid confirmed pin", async () => {
  const { pins, schema, manifest } = await load();
  assert.equal(pins.pinnedRelease.track, "latest");
  assert.equal(pins.pinnedRelease.reverifyOnUpdate, true);
  const result = checkDstackPins(pins, schema, manifest);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("a confirmed frozen tag (no track) is also accepted", async () => {
  const { pins, schema, manifest } = await load();
  const frozen = clone(pins);
  delete frozen.pinnedRelease.track;
  delete frozen.pinnedRelease.reverifyOnUpdate;
  delete frozen.pinnedRelease.autoUpdate;
  delete frozen.pinnedRelease.minSecureByDefault;
  frozen.pinnedRelease.tag = "v0.5.3-secure-by-default";
  frozen.pinnedRelease.confirmed = true;
  const result = checkDstackPins(frozen, schema, manifest);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("track-latest without reverifyOnUpdate is a hard FAIL", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.pinnedRelease.reverifyOnUpdate = false;
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pinnedRelease is INVALID")),
    result.errors.join("\n"),
  );
});

test("neither track-latest nor a confirmed tag is a hard FAIL", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  delete broken.pinnedRelease.track;
  broken.pinnedRelease.tag = null;
  broken.pinnedRelease.confirmed = false;
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("pinnedRelease is INVALID")),
  );
});

test("an empty appAuth allowlist is a hard FAIL (fail-closed)", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.appAuthAllowlist.codeHashes = [];
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) =>
      e.includes("appAuthAllowlist.codeHashes must be NON-EMPTY"),
    ),
  );
});

test("an allowlist that drops a golden manifest measurement is a hard FAIL", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  // Drop the agent golden digest from the allowlist.
  broken.appAuthAllowlist.codeHashes =
    broken.appAuthAllowlist.codeHashes.filter(
      (h) => h !== manifest.tee.measurements.agent,
    );
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) =>
      e.includes("golden tee.measurements.agent digest"),
    ),
    result.errors.join("\n"),
  );
});

test("a forbidden weakness class left unforbidden is a hard FAIL", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.forbid.devMode = false;
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false);
  assert.ok(
    result.errors.some((e) => e.includes("forbid.devMode must be true")),
  );
});

test("a missing required hardening is a hard FAIL", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.require.tlsVerify = false;
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("require.tlsVerify must be true")),
  );
});

test("a missing required production claim is a hard FAIL", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.requiredClaims.debugDisabled = false;
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("requiredClaims.debugDisabled")),
  );
});

test("rooting trust solely in dstack-KMS is rejected", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.rootOfTrust.anchor = "dstack-kms";
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("must NOT be solely dstack-KMS")),
  );
});

test("dstack-KMS as the default verifier is rejected", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.rootOfTrust.defaultVerifier = "dstack-kms";
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) =>
      e.includes("defaultVerifier must NOT be dstack-KMS"),
    ),
  );
});

test("a structurally malformed pin set is rejected by the schema", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  delete broken.forbid;
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});

test("a malformed appAuth code hash is rejected by the schema", async () => {
  const { pins, schema, manifest } = await load();
  const broken = clone(pins);
  broken.appAuthAllowlist.codeHashes = ["not-a-digest"];
  const result = checkDstackPins(broken, schema, manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});
