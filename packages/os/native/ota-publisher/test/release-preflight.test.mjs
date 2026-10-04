import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { releasePreflight as sharedPreflight } from "../release-preflight.mjs";
import { fixture } from "./release-fixture.mjs";

const releasePreflight = (options, ports) =>
  sharedPreflight(options, {
    ...ports,
    validateRelease: (descriptor) => {
      assert.equal(descriptor.product, "example-app");
      return descriptor;
    },
  });
async function scenario(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-")),
    d = fixture().release,
    file = path.join(dir, "descriptor.json");
  fs.writeFileSync(file, JSON.stringify(d));
  const order = [];
  let snapshot;
  const local = {
    contractValid: true,
    apkBytesVerified: true,
    descriptorSha256: createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex"),
    releaseId: d.releaseId,
    channel: d.channel,
    distribution: d.distribution,
    artifacts: Object.fromEntries(
      ["candidate", "recovery"].map((n) => [
        n,
        { ...d[n], runtimeVerified: true },
      ]),
    ),
  };
  const remote = {
    publicReleaseVerified: true,
    repository: d.source.repository,
    tag: d.source.tag,
    commit: d.source.commit,
    releaseId: 1,
    subjects: Object.fromEntries(
      ["candidate", "recovery"].map((n, i) => [
        n,
        { id: i + 1, url: d[n].url, sha256: d[n].sha256, length: d[n].length },
      ]),
    ),
  };
  const ports = {
    verifyArtifacts: async (o) => {
      order.push("local");
      snapshot = o.descriptorFile;
      assert.notEqual(snapshot, file);
      return local;
    },
    verifyPublic: async (desc) => {
      order.push("remote");
      assert.equal(JSON.stringify(desc), JSON.stringify(d));
      return remote;
    },
  };
  const options = {
    descriptorFile: file,
    candidate: "fixture-candidate",
    recovery: "fixture-recovery",
    expectedSigner: d.candidate.signerSha256,
    hosts: ["github.com"],
  };
  try {
    await run({ d, file, ports, options, local, remote, order });
  } finally {
    if (snapshot) assert.equal(fs.existsSync(snapshot), false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("release preflight binds fresh sequential evidence and cleans its descriptor snapshot", () =>
  scenario(async (s) => {
    const result = await releasePreflight(s.options, s.ports);
    assert.deepEqual(s.order, ["local", "remote"]);
    assert.equal(result.preflightPassed, true);
    assert.equal(result.published, false);
    assert.equal(result.metadataAuthenticated, false);
  }));
test("release preflight refuses stale or mismatched local evidence before remote calls", async () => {
  for (const change of [
    (s) => (s.local.descriptorSha256 = "b".repeat(64)),
    (s) => s.local.artifacts.recovery.length++,
    (s) => (s.local.artifacts.candidate.signerSha256 = "b".repeat(64)),
    (s) => (s.local.distribution = "standalone"),
    (s) => (s.local.apkBytesVerified = false),
  ])
    await scenario(async (s) => {
      change(s);
      await assert.rejects(
        releasePreflight(s.options, s.ports),
        /OTA preflight:/,
      );
      assert.deepEqual(s.order, ["local"]);
    });
});
test("release preflight rejects mismatched remote subjects and source identity", async () => {
  for (const change of [
    (s) => (s.remote.commit = "b".repeat(40)),
    (s) => (s.remote.subjects.candidate.sha256 = "f".repeat(64)),
    (s) =>
      (s.remote.subjects.recovery.url = "https://other.invalid/recovery.apk"),
    (s) => (s.remote.publicReleaseVerified = false),
  ])
    await scenario(async (s) => {
      change(s);
      await assert.rejects(
        releasePreflight(s.options, s.ports),
        /OTA preflight:/,
      );
    });
});
test("descriptor replacement cannot switch the object between local and remote verification", () =>
  scenario(async (s) => {
    const local = s.ports.verifyArtifacts;
    s.ports.verifyArtifacts = async (options) => {
      const r = await local(options);
      fs.writeFileSync(s.file, JSON.stringify({ ...s.d, channel: "beta" }));
      return r;
    };
    const r = await releasePreflight(s.options, s.ports);
    assert.equal(r.channel, "stable");
  }));
test("failed verifier is propagated and temporary snapshot removed", () =>
  scenario(async (s) => {
    s.ports.verifyPublic = async () => {
      throw Error("public release unavailable");
    };
    await assert.rejects(
      releasePreflight(s.options, s.ports),
      /public release unavailable/,
    );
  }));
