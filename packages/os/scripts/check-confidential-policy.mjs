#!/usr/bin/env node
// OS-3 gate: confidential-policy-check (plan §3-§4).
//
// Validates packages/os/linux/confidential/policy/confidential-policy.json:
//   1. structurally against confidential-policy.schema.json, and
//   2. against the security-critical memory + side-channel invariants that MUST
//      hold for the ELIZAOS_PROFILE=confidential guest. This file is the source
//      of measurements.policy; a relaxed setting here would silently weaken the
//      policy digest, so every invariant is enforced fail-closed.
//
// Runner: plain `node` (no third-party deps).
//   node packages/os/scripts/check-confidential-policy.mjs
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateAgainstSchema } from "./json-schema-lite.mjs";
import {
  parseArgs,
  readJson,
  repoRoot,
  sha256CanonicalJson,
} from "./os-release-lib.mjs";

const DEFAULT_POLICY = path.join(
  repoRoot,
  "packages/os/linux/confidential/policy/confidential-policy.json",
);
const SCHEMA_PATH = path.join(
  repoRoot,
  "packages/os/release/schema/confidential-policy.schema.json",
);
const RELEASE_MANIFEST = path.join(
  repoRoot,
  "packages/os/release/confidential-2026-05-21/manifest.json",
);
const IMAGE_MANIFEST = path.join(
  repoRoot,
  "packages/os/linux/confidential/image-manifest.example.json",
);

// The single source of truth for measurements.policy: the sha256 of the
// canonicalized confidential-policy.json. Edit any policy setting → this changes.
export function computePolicyDigest(policy) {
  return sha256CanonicalJson(policy);
}

// Security invariants. Each entry resolves a boolean (or compares an integer)
// from the policy document; a violation is a hard failure. Derived directly from
// plan §3 (memory) and §4 (side channels).
function policyInvariants(policy) {
  const { memory, sideChannel } = policy;
  return [
    // §3.1 swap — never to host-visible storage.
    [
      "memory.swap.hostBackedSwap must be false (host-backed swap defeats memory encryption, §3.1)",
      memory.swap.hostBackedSwap === false,
    ],
    [
      "memory.swap.zramOnly must be true (only compressed-RAM swap inside the encrypted guest, §3.1)",
      memory.swap.zramOnly === true,
    ],
    [
      "memory.swap.zramDmCrypt must be true (dm-crypt the zram backing device, §3.1)",
      memory.swap.zramDmCrypt === true,
    ],
    [
      "memory.swap.swapTargetMasked must be true (systemd swap.target masked, §3.1)",
      memory.swap.swapTargetMasked === true,
    ],
    // §3.2 mlock for secret pages.
    [
      "memory.mlock.secretPages must be true (secret pages mlocked, §3.2)",
      memory.mlock.secretPages === true,
    ],
    [
      "memory.mlock.mlockallFutureForInference must be true (§3.2)",
      memory.mlock.mlockallFutureForInference === true,
    ],
    [
      "memory.mlock.raiseRlimitMemlock must be true (§3.2)",
      memory.mlock.raiseRlimitMemlock === true,
    ],
    [
      "memory.mlock.madvDontDump must be true (secret regions excluded from core dumps, §3.2)",
      memory.mlock.madvDontDump === true,
    ],
    [
      "memory.mlock.disableCoreDumpsForSecretUnits must be true (§3.2)",
      memory.mlock.disableCoreDumpsForSecretUnits === true,
    ],
    // §3.3/§3.4 hugepages + page cache stay in private encrypted memory.
    [
      "memory.hugepages.privateEncryptedMemoryOnly must be true (weights only in private guest RAM, §3.3)",
      memory.hugepages.privateEncryptedMemoryOnly === true,
    ],
    [
      "memory.hugepages.noHostBackedFileMapping must be true (never map weights from a host-backed file, §3.3)",
      memory.hugepages.noHostBackedFileMapping === true,
    ],
    [
      "memory.pageCache.dmCryptModelVolume must be true (model/state volume is dm-crypt-over-private-block, §3.4/§4.4)",
      memory.pageCache.dmCryptModelVolume === true,
    ],
    // §3.5 zeroization + kdump.
    [
      "memory.zeroization.zeroKeyOnTeardown must be true (zero in-RAM key before TD teardown, §3.5)",
      memory.zeroization.zeroKeyOnTeardown === true,
    ],
    [
      "memory.zeroization.panicNotifierZeroesKeys must be true (panic notifier zeroes key material, §3.5)",
      memory.zeroization.panicNotifierZeroesKeys === true,
    ],
    [
      "memory.zeroization.kdumpDisabled must be true (kdump would write decrypted memory to a host target, §3.5)",
      memory.zeroization.kdumpDisabled === true,
    ],
    // §3.6 kexec / hibernation.
    [
      "memory.kexecHibernation.hibernationDisabled must be true (suspend-to-disk writes decrypted memory out, §3.6)",
      memory.kexecHibernation.hibernationDisabled === true,
    ],
    [
      "memory.kexecHibernation.kexecDisabled must be true (kexec re-enters outside the measured launch, §3.6)",
      memory.kexecHibernation.kexecDisabled === true,
    ],
    // §3.7 guest_memfd.
    [
      "memory.guestMemfd.useGuestMemfd must be true (host userspace cannot map guest-private memory, §3.7)",
      memory.guestMemfd.useGuestMemfd === true,
    ],
    [
      "memory.guestMemfd.minimalSharedWindow must be true (only the minimum shared window for mediated I/O, §3.7)",
      memory.guestMemfd.minimalSharedWindow === true,
    ],
    // §4.1 CPU speculative-execution mitigations stay ON.
    [
      "sideChannel.cpuMitigations.mitigationsOff must be false (the host is the adversary; never mitigations=off, §4.1)",
      sideChannel.cpuMitigations.mitigationsOff === false,
    ],
    [
      "sideChannel.cpuMitigations.kpti must be true (§4.1)",
      sideChannel.cpuMitigations.kpti === true,
    ],
    [
      "sideChannel.cpuMitigations.retbleed must be true (§4.1)",
      sideChannel.cpuMitigations.retbleed === true,
    ],
    [
      "sideChannel.cpuMitigations.mdsTaa must be true (§4.1)",
      sideChannel.cpuMitigations.mdsTaa === true,
    ],
    [
      "sideChannel.cpuMitigations.mmioStaleData must be true (§4.1)",
      sideChannel.cpuMitigations.mmioStaleData === true,
    ],
    [
      "sideChannel.cpuMitigations.l1tf must be true (§4.1)",
      sideChannel.cpuMitigations.l1tf === true,
    ],
    [
      "sideChannel.cpuMitigations.kaslr must be true (§4.1)",
      sideChannel.cpuMitigations.kaslr === true,
    ],
    [
      "sideChannel.cpuMitigations.randomizeKstackOffset must be true (§4.1)",
      sideChannel.cpuMitigations.randomizeKstackOffset === true,
    ],
    // §4.2 no-SMT for the confidential domain.
    [
      "sideChannel.smt.nosmt must be true (SMT sharing is a cross-thread side channel, §4.2)",
      sideChannel.smt.nosmt === true,
    ],
    // §4.3 observability lockdown.
    [
      "sideChannel.observability.perfEventParanoid must be 3 (no unprivileged perf, §4.3)",
      sideChannel.observability.perfEventParanoid === 3,
    ],
    [
      "sideChannel.observability.unprivilegedRdpmcDisabled must be true (§4.3)",
      sideChannel.observability.unprivilegedRdpmcDisabled === true,
    ],
    [
      "sideChannel.observability.denyDevMem must be true (no /dev/mem for the agent, §4.3)",
      sideChannel.observability.denyDevMem === true,
    ],
    [
      "sideChannel.observability.denyProcKcore must be true (no /proc/kcore for the agent, §4.3)",
      sideChannel.observability.denyProcKcore === true,
    ],
    [
      "sideChannel.observability.kptrRestrict must be 2 (§4.3)",
      sideChannel.observability.kptrRestrict === 2,
    ],
    [
      "sideChannel.observability.dmesgRestrict must be 1 (§4.3)",
      sideChannel.observability.dmesgRestrict === 1,
    ],
    // §4.4 secure-boot lockdown + rootfs integrity + dm-crypt user data.
    [
      "sideChannel.secureBoot.kernelLockdown must be 'confidentiality' (§4.4)",
      sideChannel.secureBoot.kernelLockdown === "confidentiality",
    ],
    [
      "sideChannel.secureBoot.imaAppraisal must be true (§4.4)",
      sideChannel.secureBoot.imaAppraisal === true,
    ],
    [
      "sideChannel.secureBoot.dmVerityRootfs must be true (rootfs tampering changes measurements.os, §4.4)",
      sideChannel.secureBoot.dmVerityRootfs === true,
    ],
    [
      "sideChannel.secureBoot.moduleSignatureEnforce must be true (§4.4)",
      sideChannel.secureBoot.moduleSignatureEnforce === true,
    ],
    [
      "sideChannel.secureBoot.dmCryptUserData must be true (persistent user data keyed off the unsealed key, §4.4)",
      sideChannel.secureBoot.dmCryptUserData === true,
    ],
    [
      "sideChannel.secureBoot.unsealBindsStateDir must be true (ELIZA_STATE_DIR unavailable until the quote verifies, §4.4)",
      sideChannel.secureBoot.unsealBindsStateDir === true,
    ],
  ];
}

// Returns { ok, errors } so the aggregate and tests can consume the result
// without spawning a process.
export function checkConfidentialPolicy(policy, schema) {
  const structure = validateAgainstSchema(policy, schema);
  if (!structure.ok) {
    return { ok: false, errors: structure.errors.map((e) => `schema: ${e}`) };
  }
  const errors = [];
  for (const [message, ok] of policyInvariants(policy)) {
    if (!ok) errors.push(message);
  }
  return { ok: errors.length === 0, errors };
}

// Fail-closed digest binding: the recomputed canonical policy digest MUST equal
// every manifest's declared `policy` measurement. This is the enforcement that
// makes "edit the policy → digest changes → launch fails" real rather than
// spec-only: a hand-placed placeholder, or a policy edit that did not regenerate
// the manifests, is rejected here. Each manifest is identified by its declared
// path to the policy digest field.
export function checkPolicyDigestConsistency(policy, manifests) {
  const expected = computePolicyDigest(policy);
  const errors = [];
  for (const { name, digest } of manifests) {
    if (digest !== expected) {
      errors.push(
        `${name} policy digest ${digest ?? "(absent)"} does not equal the ` +
          `canonical confidential-policy.json digest ${expected}; ` +
          `regenerate the manifest with generate-tee-measurements.mjs --policy`,
      );
    }
  }
  return { ok: errors.length === 0, errors, expected };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = typeof args.input === "string" ? args.input : DEFAULT_POLICY;
  const [policy, schema, releaseManifest, imageManifest] = await Promise.all([
    readJson(input),
    readJson(SCHEMA_PATH),
    readJson(RELEASE_MANIFEST),
    readJson(IMAGE_MANIFEST),
  ]);
  const result = checkConfidentialPolicy(policy, schema);
  if (!result.ok) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("confidential-policy-check: FAIL-CLOSED");
    process.exit(1);
  }

  const digestResult = checkPolicyDigestConsistency(policy, [
    {
      name: "release/confidential-2026-05-21/manifest.json tee.measurements.policy",
      digest: releaseManifest?.tee?.measurements?.policy,
    },
    {
      name: "linux/confidential/image-manifest.example.json measurements.policy",
      digest: imageManifest?.measurements?.policy,
    },
  ]);
  if (!digestResult.ok) {
    for (const error of digestResult.errors) console.error(`error: ${error}`);
    console.error(
      "confidential-policy-check: FAIL-CLOSED (policy-digest drift)",
    );
    process.exit(1);
  }

  console.log(`confidential-policy-check: PASS (${input})`);
  console.log(`  policy digest: ${digestResult.expected}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
