// Single source of truth mapping confidential-policy.json settings to the
// boot-consumable enforcement artifacts the reproducible image installs:
//
//   - cmdline.conf       kernel-cmdline fragment (one token per line)
//   - sysctl.d/*.conf    sysctl drop-in (key = value)
//   - masked-units.txt   systemd units masked at build time (one per line)
//
// Each rule names the policy path it derives from, the artifact line it emits,
// and the predicate that must hold in the policy for the line to be present.
// The generator emits exactly the lines whose predicate is true; the checker
// asserts the on-disk artifact contains exactly those lines (no more, no less),
// so the artifacts cannot drift from the policy in either direction.
//
// Plan references: §3 (memory), §4 (side channels).

// Resolve a dotted path from the policy object.
function at(policy, dottedPath) {
  return dottedPath
    .split(".")
    .reduce((node, key) => (node == null ? undefined : node[key]), policy);
}

// --- Kernel cmdline tokens -------------------------------------------------
// Each entry: the cmdline token, the policy path that gates it, and a predicate
// over that value. A token is emitted iff predicate(value) is true.
const CMDLINE_RULES = [
  {
    token: "noswap",
    path: "memory.swap.hostBackedSwap",
    when: (v) => v === false,
    why: "§3.1 host-backed swap disabled",
  },
  {
    token: "nohibernate",
    path: "memory.kexecHibernation.hibernationDisabled",
    when: (v) => v === true,
    why: "§3.6 hibernation disabled (suspend-to-disk leaks decrypted memory)",
  },
  {
    token: "nosmt=force",
    path: "sideChannel.smt.nosmt",
    when: (v) => v === true,
    why: "§4.2 no-SMT for the confidential domain",
  },
  {
    token: "lockdown=confidentiality",
    path: "sideChannel.secureBoot.kernelLockdown",
    when: (v) => v === "confidentiality",
    why: "§4.4 kernel lockdown in confidentiality mode",
  },
  {
    token: "module.sig_enforce=1",
    path: "sideChannel.secureBoot.moduleSignatureEnforce",
    when: (v) => v === true,
    why: "§4.4 module signature enforcement",
  },
  {
    token: "randomize_kstack_offset=on",
    path: "sideChannel.cpuMitigations.randomizeKstackOffset",
    when: (v) => v === true,
    why: "§4.1 randomize kernel stack offset",
  },
  {
    token: "mitigations=auto",
    path: "sideChannel.cpuMitigations.mitigationsOff",
    when: (v) => v === false,
    why: "§4.1 CPU mitigations kept ON (the host is the adversary)",
  },
];

// --- sysctl drop-in entries ------------------------------------------------
// Each entry resolves a sysctl `key = value` from a policy path. The value is
// taken directly from the policy (integer settings) or fixed for boolean gates.
const SYSCTL_RULES = [
  {
    key: "kernel.kptr_restrict",
    path: "sideChannel.observability.kptrRestrict",
    value: (v) => (Number.isInteger(v) ? String(v) : undefined),
    why: "§4.3 hide kernel pointers",
  },
  {
    key: "kernel.perf_event_paranoid",
    path: "sideChannel.observability.perfEventParanoid",
    value: (v) => (Number.isInteger(v) ? String(v) : undefined),
    why: "§4.3 restrict unprivileged perf",
  },
  {
    key: "kernel.dmesg_restrict",
    path: "sideChannel.observability.dmesgRestrict",
    value: (v) => (Number.isInteger(v) ? String(v) : undefined),
    why: "§4.3 restrict dmesg",
  },
  {
    key: "kernel.kexec_load_disabled",
    path: "memory.kexecHibernation.kexecDisabled",
    value: (v) => (v === true ? "1" : undefined),
    why: "§3.6 disable kexec_load (re-entry outside the measured launch)",
  },
  {
    key: "kernel.unprivileged_bpf_disabled",
    path: "sideChannel.secureBoot.kernelLockdown",
    value: (v) => (v === "confidentiality" ? "1" : undefined),
    why: "§4.4 lockdown denies unprivileged BPF reading kernel memory",
  },
];

// --- systemd masked units --------------------------------------------------
const MASK_RULES = [
  {
    unit: "swap.target",
    path: "memory.swap.swapTargetMasked",
    when: (v) => v === true,
    why: "§3.1 mask swap.target",
  },
  {
    unit: "hibernate.target",
    path: "memory.kexecHibernation.hibernationDisabled",
    when: (v) => v === true,
    why: "§3.6 mask hibernate.target",
  },
  {
    unit: "hybrid-sleep.target",
    path: "memory.kexecHibernation.hibernationDisabled",
    when: (v) => v === true,
    why: "§3.6 mask hybrid-sleep.target (writes suspend image to disk)",
  },
  {
    unit: "kdump.service",
    path: "memory.zeroization.kdumpDisabled",
    when: (v) => v === true,
    why: "§3.5 mask kdump (would write decrypted memory to a host target)",
  },
];

export function expectedCmdlineTokens(policy) {
  return CMDLINE_RULES.filter((r) => r.when(at(policy, r.path))).map(
    (r) => r.token,
  );
}

export function expectedSysctlEntries(policy) {
  const entries = [];
  for (const rule of SYSCTL_RULES) {
    const value = rule.value(at(policy, rule.path));
    if (value !== undefined) entries.push(`${rule.key} = ${value}`);
  }
  return entries;
}

export function expectedMaskedUnits(policy) {
  return MASK_RULES.filter((r) => r.when(at(policy, r.path))).map(
    (r) => r.unit,
  );
}

// Header lines (comments) the generator writes at the top of each artifact.
export const ARTIFACT_HEADER = (artifactName) => [
  `# GENERATED from packages/os/linux/confidential/policy/confidential-policy.json`,
  `# by packages/os/scripts/generate-confidential-artifacts.mjs — do not hand-edit.`,
  `# ${artifactName}: enforcement form of the confidential policy (plan §3-§4).`,
  `# Consistency with the policy is asserted by check-confidential-artifacts.mjs.`,
];

export { CMDLINE_RULES, MASK_RULES, SYSCTL_RULES };
