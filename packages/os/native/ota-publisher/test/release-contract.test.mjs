import test from "node:test";
import assert from "node:assert/strict";
import { createReleaseContract } from "../release-contract.mjs";
const host = {
  product: "example-app",
  packageId: "org.example.app",
  cohortNamespace: "example-ota-v1",
};
const { validateRelease, admitRelease, cohortBucket } =
  createReleaseContract(host);
import { parseDescriptorJson } from "../strict-json.mjs";
import { hash, fixture, invalid, deferred } from "./release-fixture.mjs";
test("complete release contract admits only a compatible candidate/recovery pair", () => {
  const { release, device, policy } = fixture();
  assert.equal(validateRelease(release, policy), release);
  assert.equal(admitRelease(release, device, policy).decision, "eligible");
  const parsed = parseDescriptorJson(Buffer.from(JSON.stringify(release)));
  assert.equal(admitRelease(parsed, device, policy).decision, "eligible");
});
for (const [name, mutate] of Object.entries(invalid))
  test(`release rejects ${name}`, () => {
    const { release, policy } = fixture();
    mutate(release);
    assert.throws(() => validateRelease(release, policy), /OTA descriptor/);
  });
for (const [reason, mutate] of deferred)
  test(`admission defers ${reason}`, () => {
    const f = fixture();
    mutate(f);
    assert.deepEqual(admitRelease(f.release, f.device, f.policy), {
      decision: "defer",
      reason,
    });
  });
test("missing or non-finite device and trust observations cannot pass comparisons", () => {
  for (const key of Object.keys(fixture().device)) {
    const f = fixture();
    delete f.device[key];
    assert.throws(() => admitRelease(f.release, f.device, f.policy));
  }
  for (const key of [
    "minimumSequence",
    "minimumRolloutRevision",
    "securityFloor",
    "trustedNowMs",
  ])
    for (const value of [undefined, NaN, Infinity, -1]) {
      const f = fixture();
      f.policy[key] = value;
      assert.throws(() => admitRelease(f.release, f.device, f.policy));
    }
});
test("exact-byte Stable promotion needs no reinstall, but revocation wins", () => {
  const f = fixture();
  f.device.installedSha256 = f.release.candidate.sha256;
  f.device.installedVersionCode = 2;
  assert.deepEqual(admitRelease(f.release, f.device, f.policy), {
    decision: "already-installed",
    effectiveChannel: "stable",
  });
  f.release.rollout.revokedSha256 = [f.device.installedSha256];
  assert.equal(
    admitRelease(f.release, f.device, f.policy).reason,
    "revoked-artifact",
  );
});
test("cohort assignment is reproducible and larger thresholds retain earlier devices", () => {
  const f = fixture(),
    bucket = cohortBucket(f.device.opaqueCohortId, f.release.rollout.seed);
  assert.equal(
    bucket,
    cohortBucket(f.device.opaqueCohortId, f.release.rollout.seed),
  );
  f.release.rollout.threshold = bucket;
  assert.equal(
    admitRelease(f.release, f.device, f.policy).reason,
    "outside-cohort",
  );
  f.release.rollout.threshold = bucket + 1;
  assert.equal(
    admitRelease(f.release, f.device, f.policy).decision,
    "eligible",
  );
  assert.throws(() =>
    cohortBucket("person@example.com", f.release.rollout.seed),
  );
});
test("bounded JSON refuses duplicate keys, parser ambiguities and resource exhaustion", () => {
  for (const bad of [
    '{"channel":"stable","channel":"beta"}',
    '{"a":{"x":1,"\\u0078":2}}',
    '{"a":01}',
    '{"a":1e2}',
    '{"a":-0}',
    '{"a":9007199254740993}',
    '{"a":true,}',
    "[1,]",
    '{"a":NaN}',
    "{} trailing",
    "/*comment*/{}",
    '["unterminated]',
    "[".repeat(34) + "0" + "]".repeat(34),
    JSON.stringify("x".repeat(4097)),
    JSON.stringify("\ud800"),
  ])
    assert.throws(() => parseDescriptorJson(Buffer.from(bad)));
  assert.throws(() => parseDescriptorJson(Buffer.from([0xc3, 0x28])));
  assert.throws(() => parseDescriptorJson(Buffer.alloc(1024 * 1024 + 1)));
  assert.throws(() =>
    parseDescriptorJson(Buffer.from(JSON.stringify(Array(4097).fill(1)))),
  );
  assert.equal(
    Object.getPrototypeOf(
      parseDescriptorJson(Buffer.from('{"__proto__":{"polluted":true}}')),
    ),
    null,
  );
  assert.equal({}.polluted, undefined);
});

test("authenticated descriptors remain bound to the provisioned repository and signer on promotion", () => {
  const f = fixture();
  f.policy.repository = "another/repository";
  assert.equal(
    admitRelease(f.release, f.device, f.policy).reason,
    "repository-mismatch",
  );
  f.policy.repository = f.release.source.repository;
  f.device.installedSha256 = f.release.candidate.sha256;
  f.device.installedVersionCode = f.release.candidate.versionCode;
  f.device.signerSha256 = "a".repeat(64);
  assert.equal(
    admitRelease(f.release, f.device, f.policy).reason,
    "signer-mismatch",
  );
});

test("host identity and cohort namespace are required and captured", () => {
  for (const key of Object.keys(host)) {
    const config = { ...host };
    delete config[key];
    assert.throws(() => createReleaseContract(config));
  }
  const config = { ...host };
  const contract = createReleaseContract(config);
  config.product = "changed";
  config.cohortNamespace = "changed";
  const f = fixture();
  assert.equal(contract.validateRelease(f.release, f.policy), f.release);
  assert.equal(
    contract.cohortBucket(f.device.opaqueCohortId, f.release.rollout.seed),
    cohortBucket(f.device.opaqueCohortId, f.release.rollout.seed),
  );
  const other = createReleaseContract({
    ...host,
    product: "another-app",
    packageId: "org.another.app",
  });
  assert.throws(() => other.validateRelease(f.release, f.policy));
});
