// The read-only update-channel client on synthetic manifests. Contract signature checks are
// those of release-contract.ts (exercised by android-release-safety); here an injected
// validator stands in for a verified contract, and one unsigned contract goes through the
// real validator. Nothing is downloaded, staged or applied.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createUpdateChannelClient,
  evaluateUpdateChannel,
  parseFingerprint,
  UPDATE_CHANNEL_CLIENT_ENABLED,
} from "../android/update-channel-client.mjs";

const BOOTED =
  "elizaOS/eliza_stallion_phone/stallion:17/CP2A.261005.001/1:user/release-keys";
const OFFERED =
  "elizaOS/eliza_stallion_phone/stallion:17/CP2A.261105.001/2:user/release-keys";

function release(fingerprint = OFFERED, overrides = {}) {
  return {
    releaseId: "r2",
    version: "2.0.0",
    tag: "v2.0.0",
    channel: "stable",
    operation: "os-install",
    target: { id: "pixel10a", codename: "stallion", kind: "physical" },
    archive: { filename: "stallion-2.0.0.zip", sha256: "a".repeat(64) },
    buildFingerprint: fingerprint,
    ...overrides,
  };
}

function manifest(r = release(), overrides = {}) {
  return {
    schemaVersion: 2,
    version: "2.0.0",
    channel: "stable",
    tag: "v2.0.0",
    artifacts: [
      {
        target: r.target.id,
        codename: r.target.codename,
        filename: r.archive.filename,
        sha256: r.archive.sha256,
        subjectSha256: "s".repeat(64),
        downloadUrl: "https://example.invalid/never-fetched.zip",
        contract: { release: r },
        ...overrides,
      },
    ],
  };
}

const verified = (contract) => ({
  release: contract.release,
  subjectSha256: "s".repeat(64),
});
const evaluate = (m, fingerprint = BOOTED, extra = {}) =>
  evaluateUpdateChannel({
    manifest: m,
    channel: "stable",
    booted: { fingerprint },
    validate: verified,
    ...extra,
  });

test("fingerprints are parsed into their identity parts", () => {
  assert.deepEqual(parseFingerprint(BOOTED), {
    brand: "elizaOS",
    product: "eliza_stallion_phone",
    device: "stallion",
    release: "17",
    id: "CP2A.261005.001",
    incremental: "1",
    type: "user",
    tags: "release-keys",
  });
  assert.equal(parseFingerprint("garbage"), null);
});

test("a verified release is reported available or current, never downloaded or applied", () => {
  const available = evaluate(manifest());
  assert.equal(available.state, "available");
  assert.equal(available.release.buildFingerprint, OFFERED);
  assert.equal(available.downloaded, false);
  assert.equal(available.applied, false);
  assert.equal(evaluate(manifest(), OFFERED).state, "current");
});

test("anything that does not bind to the booted product is refused", () => {
  const refused = (result, pattern) => {
    assert.equal(result.state, "refused");
    assert.match(result.problems.join("\n"), pattern);
  };
  refused(evaluate(manifest(), "nonsense"), /unreadable/);
  refused(evaluate({ ...manifest(), schemaVersion: 1 }), /schemaVersion 2/);
  refused(evaluate({ ...manifest(), channel: "beta" }), /for beta, not stable/);
  refused(
    evaluate(
      manifest(release(OFFERED, { target: { id: "x", codename: "other" } })),
    ),
    /no release for stallion/,
  );
  const m = manifest();
  m.artifacts.push(m.artifacts[0]);
  refused(evaluate(m), /lists 2 releases/);
  refused(
    evaluate(
      manifest(release(OFFERED.replace("eliza_stallion_phone", "other_phone"))),
    ),
    /not a build of the booted product/,
  );
  refused(
    evaluate(manifest(release(OFFERED.replace(":user/", ":userdebug/")))),
    /userdebug build/,
  );
  refused(
    evaluate(manifest(release(), { sha256: "b".repeat(64) })),
    /not the signed contract's archive/,
  );
  refused(
    evaluate(manifest(release(OFFERED, { tag: "v9" }))),
    /channel or tag/,
  );
  refused(
    evaluate(manifest(), BOOTED, {
      validate: () => {
        throw new Error("missing trusted independent release signature");
      },
    }),
    /does not verify: missing trusted/,
  );
  // The real validator refuses an unsigned contract.
  refused(
    evaluateUpdateChannel({
      manifest: manifest(),
      channel: "stable",
      booted: { fingerprint: BOOTED },
      policy: {
        trust: {
          schemaVersion: 1,
          keys: [],
          revokedReleaseDigests: [],
          revokedKeyIds: [],
        },
        inventory: { targets: [] },
      },
    }),
    /does not verify/,
  );
});

test("the client is off by default and then fetches nothing", async () => {
  assert.equal(UPDATE_CHANNEL_CLIENT_ENABLED, false);
  let fetched = 0;
  const client = createUpdateChannelClient({
    channel: "stable",
    fetchManifest: () => {
      fetched++;
      return manifest();
    },
    readBootedFingerprint: () => BOOTED,
    validate: verified,
  });
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.check(), {
    state: "disabled",
    problems: [],
    downloaded: false,
    applied: false,
  });
  assert.equal(fetched, 0);
});

test("an enabled client reads only the manifest", async () => {
  let fetched = 0;
  const client = createUpdateChannelClient({
    enabled: true,
    channel: "stable",
    fetchManifest: async () => {
      fetched++;
      return JSON.stringify(manifest());
    },
    readBootedFingerprint: async () => BOOTED,
    validate: verified,
  });
  const result = await client.check();
  assert.equal(result.state, "available");
  assert.equal(result.downloaded, false);
  assert.equal(result.applied, false);
  assert.equal(fetched, 1);
  const offline = createUpdateChannelClient({
    enabled: true,
    channel: "stable",
    fetchManifest: () => {
      throw new Error("offline");
    },
    readBootedFingerprint: () => BOOTED,
  });
  assert.match(
    (await offline.check()).problems.join(),
    /could not be read: offline/,
  );
  assert.equal((await offline.check()).state, "unavailable");
});
