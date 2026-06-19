// OS-3 confidential-policy-check tests.
// Runner: node --test (bun test segfaults on the OS lane in this environment).
//   node --test packages/os/scripts/__tests__/check-confidential-policy.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { checkConfidentialPolicy } from "../check-confidential-policy.mjs";
import { readJson, repoRoot } from "../os-release-lib.mjs";

const policyPath = path.join(
  repoRoot,
  "packages/os/linux/confidential/policy/confidential-policy.json",
);
const schemaPath = path.join(
  repoRoot,
  "packages/os/release/schema/confidential-policy.schema.json",
);

async function load() {
  return {
    policy: await readJson(policyPath),
    schema: await readJson(schemaPath),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("shipped confidential policy passes the gate", async () => {
  const { policy, schema } = await load();
  const result = checkConfidentialPolicy(policy, schema);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("host-backed swap enabled is rejected fail-closed", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.memory.swap.hostBackedSwap = true;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) =>
      e.includes("memory.swap.hostBackedSwap must be false"),
    ),
    result.errors.join("\n"),
  );
});

test("disabling mlock secret pages is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.memory.mlock.secretPages = false;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("memory.mlock.secretPages")));
});

test("enabling hibernation is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.memory.kexecHibernation.hibernationDisabled = false;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("hibernationDisabled")));
});

test("enabling kexec is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.memory.kexecHibernation.kexecDisabled = false;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("kexecDisabled")));
});

test("mitigations=off is rejected (the host is the adversary)", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.sideChannel.cpuMitigations.mitigationsOff = true;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("mitigationsOff must be false")),
  );
});

test("disabling nosmt is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.sideChannel.smt.nosmt = false;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("smt.nosmt")));
});

test("relaxing kernel lockdown below confidentiality is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.sideChannel.secureBoot.kernelLockdown = "integrity";
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("kernelLockdown")));
});

test("weakening perf_event_paranoid is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.sideChannel.observability.perfEventParanoid = 1;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("perfEventParanoid must be 3")),
  );
});

test("dropping dm-crypt for user data is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.sideChannel.secureBoot.dmCryptUserData = false;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("dmCryptUserData")));
});

test("enabling kdump is rejected", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.memory.zeroization.kdumpDisabled = false;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("kdumpDisabled")));
});

test("a structurally malformed policy is rejected by the schema", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  delete broken.memory.swap;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.startsWith("schema:")));
});

test("an unknown extra property is rejected by the schema", async () => {
  const { policy, schema } = await load();
  const broken = clone(policy);
  broken.memory.swap.bogus = true;
  const result = checkConfidentialPolicy(broken, schema);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("additional property not allowed")),
    result.errors.join("\n"),
  );
});
