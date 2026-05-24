// GAP 1: policy-digest binding tests (OS-3).
// Runner: node --test (bun test segfaults on the OS lane in this environment).
//   node --test packages/os/scripts/__tests__/check-confidential-policy-digest.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  checkPolicyDigestConsistency,
  computePolicyDigest,
} from "../check-confidential-policy.mjs";
import { readJson, repoRoot, sha256CanonicalJson } from "../os-release-lib.mjs";

const policyPath = path.join(
  repoRoot,
  "packages/os/linux/confidential/policy/confidential-policy.json",
);
const releaseManifestPath = path.join(
  repoRoot,
  "packages/os/release/confidential-2026-05-21/manifest.json",
);
const imageManifestPath = path.join(
  repoRoot,
  "packages/os/linux/confidential/image-manifest.example.json",
);

const clone = (value) => JSON.parse(JSON.stringify(value));

test("canonical digest is deterministic regardless of key order", async () => {
  const policy = await readJson(policyPath);
  const reordered = {};
  for (const key of Object.keys(policy).reverse()) reordered[key] = policy[key];
  // also reorder a nested object
  if (reordered.memory?.swap) {
    const swap = reordered.memory.swap;
    const re = {};
    for (const k of Object.keys(swap).reverse()) re[k] = swap[k];
    reordered.memory = { ...reordered.memory, swap: re };
  }
  assert.equal(computePolicyDigest(policy), computePolicyDigest(reordered));
});

test("digest matches the documented golden value", async () => {
  const policy = await readJson(policyPath);
  assert.equal(
    computePolicyDigest(policy),
    "sha256:f664e1be4568d6dd802ca97c6a8c06479877d699b8935f3c6e137d8856e01b6c",
  );
});

test("both shipped manifests carry the real policy digest", async () => {
  const [policy, releaseManifest, imageManifest] = await Promise.all([
    readJson(policyPath),
    readJson(releaseManifestPath),
    readJson(imageManifestPath),
  ]);
  const result = checkPolicyDigestConsistency(policy, [
    {
      name: "release tee.measurements.policy",
      digest: releaseManifest.tee.measurements.policy,
    },
    {
      name: "release tee.policyDigest",
      digest: releaseManifest.tee.policyDigest,
    },
    {
      name: "image-manifest measurements.policy",
      digest: imageManifest.measurements.policy,
    },
  ]);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("editing the policy breaks the manifest binding (fail-closed)", async () => {
  const policy = await readJson(policyPath);
  const edited = clone(policy);
  // Relax a security setting: this MUST change the digest and no longer match.
  edited.memory.swap.hostBackedSwap = true;
  const goldenDigest = computePolicyDigest(policy);
  assert.notEqual(computePolicyDigest(edited), goldenDigest);
  const result = checkPolicyDigestConsistency(edited, [
    { name: "release tee.measurements.policy", digest: goldenDigest },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("does not equal")));
});

test("a placeholder digest is rejected", async () => {
  const policy = await readJson(policyPath);
  const result = checkPolicyDigestConsistency(policy, [
    {
      name: "placeholder",
      digest: `sha256:${"a".repeat(64)}`,
    },
  ]);
  assert.equal(result.ok, false);
});

test("generate-tee-measurements --policy uses the canonical digest", async () => {
  // The generator computes the policy measurement exactly as the checker does.
  const policy = await readJson(policyPath);
  assert.equal(sha256CanonicalJson(policy), computePolicyDigest(policy));
});
