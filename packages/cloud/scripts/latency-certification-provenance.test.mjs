/** Exercises provenance against real temporary Git history and deployment boundaries. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyExactDeployment } from "./cloud-latency-certification.mjs";
import {
  verifyCertificationSource,
  withVerifiedDeployment,
} from "./latency-certification-provenance.mjs";

test("real Git ancestry rejects untrusted revisions and binds changed verifier contracts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "latency-provenance-test-"));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  const commit = async (file, value) => {
    await writeFile(join(cwd, file), value);
    git("add", file);
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init");
    const base = await commit("ordinary.txt", "base");
    const sourceSha = await commit("ordinary.txt", "later");
    const config = {
      sourceRef: "refs/heads/develop",
      sourceSha,
      deploySha: base,
    };
    assert.equal(
      (await verifyCertificationSource(config, { cwd })).relationship,
      "develop_ancestor",
    );
    assert.equal(
      (
        await verifyCertificationSource(
          { ...config, deploySha: sourceSha },
          { cwd },
        )
      ).relationship,
      "identical",
    );
    const unrelated = git("commit-tree", "HEAD^{tree}", "-m", "unrelated");
    const descendant = git(
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      sourceSha,
      "-m",
      "descendant",
    );
    for (const change of [
      { sourceRef: "refs/heads/feature" },
      { sourceSha: base },
      { deploySha: "not-a-sha" },
      { deploySha: "a".repeat(40) },
      { deploySha: unrelated },
      { deploySha: descendant },
      { acknowledgedContractDigest: "b".repeat(64) },
    ])
      await assert.rejects(
        verifyCertificationSource({ ...config, ...change }, { cwd }),
      );

    await mkdir(join(cwd, "packages/cloud/scripts"), { recursive: true });
    const changedSha = await commit(
      "packages/cloud/scripts/chat-latency.mjs",
      "export const changed = true;\n",
    );
    const changed = { ...config, sourceSha: changedSha };
    let digest;
    await assert.rejects(
      verifyCertificationSource(changed, { cwd }),
      (error) => {
        digest = /acknowledgement: ([a-f0-9]{64})$/.exec(error.message)?.[1];
        return Boolean(digest);
      },
    );
    const receipt = await verifyCertificationSource(
      { ...changed, acknowledgedContractDigest: digest },
      { cwd },
    );
    assert.equal(receipt.verifierContractChanged, true);
    assert.equal(receipt.verifierContractAcknowledged, true);
    assert.deepEqual(receipt.changedVerifierPaths, [
      "packages/cloud/scripts/chat-latency.mjs",
    ]);
    assert.equal(receipt.sourceSha, changedSha);
    assert.equal(receipt.deploySha, base);
    await assert.rejects(
      verifyCertificationSource(
        { ...changed, acknowledgedContractDigest: "c".repeat(64) },
        { cwd },
      ),
    );
    const newerSha = await commit(
      "packages/cloud/scripts/chat-latency.mjs",
      "export const changed = false;\n",
    );
    await assert.rejects(
      verifyCertificationSource(
        { ...changed, sourceSha: newerSha, acknowledgedContractDigest: digest },
        { cwd },
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("deployment movement rejects measured evidence and initial mismatch prevents measurement", async () => {
  const sha = "a".repeat(40);
  for (const mismatchAt of [0, 1, -1]) {
    let checks = 0;
    let measurements = 0;
    const verify = (expected) =>
      verifyExactDeployment(expected, async () =>
        Response.json({
          commit: checks++ === mismatchAt ? "b".repeat(40) : sha,
          environment: "staging",
        }),
      );
    const run = withVerifiedDeployment(sha, verify, async () => {
      measurements++;
      return "measured";
    });
    if (mismatchAt === -1) assert.equal(await run, "measured");
    else await assert.rejects(run, /expected commit/);
    assert.equal(measurements, mismatchAt === 0 ? 0 : 1);
    assert.equal(checks, mismatchAt === 0 ? 1 : 2);
  }
});
