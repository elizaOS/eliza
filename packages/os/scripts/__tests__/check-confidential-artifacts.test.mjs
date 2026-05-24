// GAP 2: enforcement-artifact consistency tests (OS-3).
// Runner: node --test (bun test segfaults on the OS lane in this environment).
//   node --test packages/os/scripts/__tests__/check-confidential-artifacts.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  checkConfidentialArtifacts,
  loadArtifacts,
} from "../check-confidential-artifacts.mjs";
import {
  expectedCmdlineTokens,
  expectedMaskedUnits,
  expectedSysctlEntries,
} from "../confidential-enforcement-map.mjs";
import { renderArtifacts } from "../generate-confidential-artifacts.mjs";
import { readJson, repoRoot } from "../os-release-lib.mjs";

const policyPath = path.join(
  repoRoot,
  "packages/os/linux/confidential/policy/confidential-policy.json",
);

const clone = (value) => JSON.parse(JSON.stringify(value));

test("shipped artifacts on disk are consistent with the policy", async () => {
  const [policy, artifacts] = await Promise.all([
    readJson(policyPath),
    loadArtifacts(),
  ]);
  const result = checkConfidentialArtifacts(policy, artifacts);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("freshly rendered artifacts pass their own check (round-trip)", async () => {
  const policy = await readJson(policyPath);
  const rendered = renderArtifacts(policy);
  const result = checkConfidentialArtifacts(policy, rendered);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("expected sets cover the security-critical mappings", async () => {
  const policy = await readJson(policyPath);
  assert.ok(expectedCmdlineTokens(policy).includes("noswap"));
  assert.ok(expectedCmdlineTokens(policy).includes("nohibernate"));
  assert.ok(expectedCmdlineTokens(policy).includes("nosmt=force"));
  assert.ok(expectedCmdlineTokens(policy).includes("lockdown=confidentiality"));
  assert.ok(expectedSysctlEntries(policy).includes("kernel.kptr_restrict = 2"));
  assert.ok(
    expectedSysctlEntries(policy).includes("kernel.perf_event_paranoid = 3"),
  );
  assert.ok(
    expectedSysctlEntries(policy).includes("kernel.dmesg_restrict = 1"),
  );
  assert.ok(expectedMaskedUnits(policy).includes("swap.target"));
  assert.ok(expectedMaskedUnits(policy).includes("hibernate.target"));
  assert.ok(expectedMaskedUnits(policy).includes("kdump.service"));
});

test("relaxing the policy without regenerating artifacts fails closed (stale-strict)", async () => {
  // On-disk artifacts still carry `noswap`/`swap.target`, but the policy now
  // permits host-backed swap → the artifact is no longer derivable from policy.
  const [policy, artifacts] = await Promise.all([
    readJson(policyPath),
    loadArtifacts(),
  ]);
  const relaxed = clone(policy);
  relaxed.memory.swap.hostBackedSwap = true; // drops `noswap`
  relaxed.memory.swap.swapTargetMasked = false; // drops `swap.target` mask
  const result = checkConfidentialArtifacts(relaxed, artifacts);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("noswap")) ||
      result.errors.some((e) => e.includes("swap.target")),
    result.errors.join("\n"),
  );
});

test("a hand-edited artifact with an extra line fails closed", async () => {
  const policy = await readJson(policyPath);
  const rendered = renderArtifacts(policy);
  const tampered = {
    ...rendered,
    cmdline: `${rendered.cmdline}mitigations=off\n`,
  };
  const result = checkConfidentialArtifacts(policy, tampered);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.includes("not derivable")),
    result.errors.join("\n"),
  );
});

test("a missing required cmdline token fails closed", async () => {
  const policy = await readJson(policyPath);
  const rendered = renderArtifacts(policy);
  const tampered = {
    ...rendered,
    cmdline: rendered.cmdline.replace("nohibernate\n", ""),
  };
  const result = checkConfidentialArtifacts(policy, tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("nohibernate")));
});

test("a stronger policy demands a stronger sysctl drop-in", async () => {
  const policy = await readJson(policyPath);
  const rendered = renderArtifacts(policy);
  // kexecDisabled drives kernel.kexec_load_disabled = 1; flip it off in the
  // artifact only and confirm the check fails.
  const tampered = {
    ...rendered,
    sysctl: rendered.sysctl.replace("kernel.kexec_load_disabled = 1\n", ""),
  };
  const result = checkConfidentialArtifacts(policy, tampered);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("kexec_load_disabled")));
});
