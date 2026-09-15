/**
 * Deny-by-default plugin admission for synthetic/scenario execution (#24394).
 * When a process declares synthetic mode, only the scenario-declared packages
 * and the minimal boot-required infrastructure may enter the plugin load set;
 * every other collected package — connectors, device bridges, provider
 * plugins, host-integration surfaces — is denied at admission with its
 * collection provenance recorded, and any denial fails the boot. A synthetic
 * test process must never infer authority to read host messages, credentials,
 * devices, files, or real services from ambient configuration.
 *
 * The policy is explicit, not inferred: `ELIZA_SYNTHETIC_MODE=1` activates it
 * and `ELIZA_SYNTHETIC_PLUGIN_ALLOWLIST` carries the scenario-declared package
 * names. An absent allowlist in synthetic mode admits only the boot-required
 * set, so a composition that forgets to declare a capability fails loudly
 * instead of silently inheriting the operator's connectors.
 */

import { ElizaError } from "@elizaos/core";
import type { PluginLoadReasons } from "./plugin-collector.ts";

/**
 * Packages a synthetic runtime cannot boot without. Deliberately minimal:
 * everything else in CORE_PLUGINS (browser, shell/coding-tools, app-control,
 * connectors, providers) carries exactly the host authority synthetic mode
 * exists to deny, so compositions must declare those explicitly.
 */
export const SYNTHETIC_ALWAYS_ADMITTED_PACKAGES: readonly string[] = [
  "@elizaos/plugin-sql",
];

const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/** Ledger rows are diagnostics with a hard cap; overflow is counted, never silent. */
export const SYNTHETIC_DENIAL_LEDGER_MAX_ENTRIES = 500;

export interface SyntheticAdmissionPolicy {
  active: boolean;
  /** Exact package names the composition declared (beyond the always-admitted set). */
  allowlist: ReadonlySet<string>;
}

export interface SyntheticAdmissionDenial {
  packageName: string;
  /** First-winning collection provenance (e.g. `connectors.imessage`, `env: X`). */
  provenance: string;
}

export interface SyntheticAdmissionResult {
  admitted: Set<string>;
  denials: SyntheticAdmissionDenial[];
  /** Denials beyond the ledger cap; 0 unless a pathological set overflows it. */
  overflowDenialCount: number;
}

/**
 * Read the synthetic admission policy from the environment. Fail-closed: a
 * malformed allowlist entry is a boot error, never a silently narrowed or
 * widened list.
 */
export function readSyntheticAdmissionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): SyntheticAdmissionPolicy {
  const active = env.ELIZA_SYNTHETIC_MODE?.trim() === "1";
  if (!active) {
    return { active: false, allowlist: new Set() };
  }
  const raw = env.ELIZA_SYNTHETIC_PLUGIN_ALLOWLIST ?? "";
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const invalid = entries.filter((entry) => !PACKAGE_NAME_PATTERN.test(entry));
  if (invalid.length > 0) {
    throw new ElizaError(
      "SyntheticAdmission: ELIZA_SYNTHETIC_PLUGIN_ALLOWLIST contains entries that are not package names",
      {
        code: "SYNTHETIC_ALLOWLIST_INVALID",
        context: { invalid },
      },
    );
  }
  return { active: true, allowlist: new Set(entries) };
}

/**
 * Partition a collected plugin load set under the synthetic policy. Pure: the
 * caller owns persisting the denial ledger and failing the boot.
 */
export function applySyntheticAdmission(
  pluginsToLoad: ReadonlySet<string>,
  loadReasons: PluginLoadReasons,
  policy: SyntheticAdmissionPolicy,
): SyntheticAdmissionResult {
  if (!policy.active) {
    return {
      admitted: new Set(pluginsToLoad),
      denials: [],
      overflowDenialCount: 0,
    };
  }
  const admitted = new Set<string>();
  const denials: SyntheticAdmissionDenial[] = [];
  let overflowDenialCount = 0;
  const alwaysAdmitted = new Set(SYNTHETIC_ALWAYS_ADMITTED_PACKAGES);
  for (const packageName of pluginsToLoad) {
    if (alwaysAdmitted.has(packageName) || policy.allowlist.has(packageName)) {
      admitted.add(packageName);
      continue;
    }
    if (denials.length >= SYNTHETIC_DENIAL_LEDGER_MAX_ENTRIES) {
      overflowDenialCount += 1;
      continue;
    }
    denials.push({
      packageName,
      provenance: loadReasons.get(packageName) ?? "unknown",
    });
  }
  return { admitted, denials, overflowDenialCount };
}

/**
 * Enforce the policy result: any denial is recorded and fails the run. The
 * error carries the complete bounded ledger so CI retains exactly what tried
 * to start and why it was collected.
 */
export function assertSyntheticAdmission(
  result: SyntheticAdmissionResult,
): void {
  if (result.denials.length === 0 && result.overflowDenialCount === 0) {
    return;
  }
  throw new ElizaError(
    `SyntheticAdmission: ${result.denials.length + result.overflowDenialCount} plugin(s) denied by synthetic-mode admission — the run must declare every capability it starts`,
    {
      code: "SYNTHETIC_ADMISSION_DENIED",
      context: {
        denials: result.denials,
        overflowDenialCount: result.overflowDenialCount,
      },
      severity: "fatal",
    },
  );
}
