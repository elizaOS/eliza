import fs from "node:fs";
import path from "node:path";
import { findCatalogModel, MODEL_CATALOG } from "./catalog";
import {
  type DflashMetricsSnapshot,
  dflashLlamaServer,
  getDflashRuntimeStatus,
} from "./dflash-server";
import { listInstalledModels } from "./registry";
import type { InstalledModel } from "./types";

interface DflashTargetMeta {
  drafter?: {
    targetCheckpointSha256?: string | null;
    matchesTargetCheckpoint?: boolean;
  };
  acceptanceWindow?: [number, number] | null;
  acceptanceRate?: number | null;
}

/**
 * Read `<bundleRoot>/dflash/target-meta.json` for an installed target.
 * Returns null when the bundle root is unknown, the file is missing, or
 * it doesn't parse. The drafter↔target checkpoint-hash parity check
 * downgrades to `warn` (not `fail`) on a missing file so legacy / custom
 * bundles without the metadata don't trip the doctor — the *publish*
 * gate is where a missing/mismatched hash is fatal.
 */
function readTargetMeta(installed: InstalledModel | undefined): DflashTargetMeta | null {
  const root = installed?.bundleRoot;
  if (!root) return null;
  const metaPath = path.join(root, "dflash", "target-meta.json");
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DflashTargetMeta;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export type DflashDoctorStatus = "pass" | "warn" | "fail";

export interface DflashDoctorCheck {
  id: string;
  status: DflashDoctorStatus;
  label: string;
  detail: string;
  fix?: string;
}

export interface DflashDoctorReport {
  ok: boolean;
  checks: DflashDoctorCheck[];
}

const DFLASH_TARGET_IDS = MODEL_CATALOG.filter(
  (model) => model.runtime?.dflash,
).map((model) => model.id);

/**
 * Run the DFlash health check. Reports pass/warn/fail across:
 *   - DFlash runtime + llama-server binary discovery
 *   - per-pair installation state (target + drafter)
 *   - per-pair tokenizer-family parity (drafter must share the target's vocab)
 *   - if a server is currently loaded, the most recent acceptance-rate
 *     readout from `/metrics`
 *
 * The tokenizer parity check uses the catalog's `tokenizerFamily` field,
 * which is the same source of truth that catalog.test.ts enforces. A
 * missing field on either side downgrades the pair to fail with a clear
 * remediation pointing at the catalog edit.
 */
export async function runDflashDoctor(): Promise<DflashDoctorReport> {
  const checks: DflashDoctorCheck[] = [];
  const runtime = getDflashRuntimeStatus();
  checks.push({
    id: "dflash-enabled",
    status: runtime.enabled ? "pass" : runtime.required ? "fail" : "warn",
    label: "DFlash runtime",
    detail: runtime.reason,
    fix: runtime.enabled
      ? undefined
      : "node packages/app-core/scripts/build-llama-cpp-dflash.mjs",
  });

  checks.push({
    id: "llama-server-binary",
    status:
      runtime.binaryPath && fs.existsSync(runtime.binaryPath) ? "pass" : "fail",
    label: "llama-server",
    detail: runtime.binaryPath ?? "No compatible binary found",
    fix: "ELIZA_DFLASH_LLAMA_SERVER=/path/to/llama-server",
  });

  const installed = await listInstalledModels();
  const installedById = new Map(installed.map((model) => [model.id, model]));
  const installedIds = new Set(installedById.keys());
  for (const targetId of DFLASH_TARGET_IDS) {
    const target = findCatalogModel(targetId);
    const dflash = target?.runtime?.dflash;
    if (!target || !dflash) continue;
    const drafter = findCatalogModel(dflash.drafterModelId);
    const targetInstalled = installedIds.has(target.id);
    const drafterInstalled = installedIds.has(dflash.drafterModelId);
    checks.push({
      id: `${target.id}:target`,
      status: targetInstalled ? "pass" : "warn",
      label: `${target.displayName} target`,
      detail: targetInstalled ? "Installed" : `Download ${target.id}`,
      fix: `eliza local-inference download ${target.id}`,
    });
    checks.push({
      id: `${target.id}:drafter`,
      status: drafterInstalled ? "pass" : targetInstalled ? "fail" : "warn",
      label: `${target.displayName} drafter`,
      detail: drafterInstalled
        ? "Installed"
        : `Missing companion ${dflash.drafterModelId}`,
      fix: `eliza local-inference download ${dflash.drafterModelId}`,
    });
    // Vocab parity: drafter and target must share a tokenizer family or
    // llama.cpp's speculative-decoding loop rejects every drafted token at
    // verify. See docs/porting/dflash-drafter-strategy.md.
    const targetFamily = target.tokenizerFamily;
    const drafterFamily = drafter?.tokenizerFamily;
    if (!drafter) {
      checks.push({
        id: `${target.id}:tokenizer`,
        status: "fail",
        label: `${target.displayName} tokenizer parity`,
        detail: `Drafter ${dflash.drafterModelId} not in catalog`,
        fix: "Add drafter entry to catalog.ts",
      });
    } else if (!targetFamily || !drafterFamily) {
      checks.push({
        id: `${target.id}:tokenizer`,
        status: "fail",
        label: `${target.displayName} tokenizer parity`,
        detail: `Missing tokenizerFamily — target=${targetFamily ?? "<unset>"} drafter=${drafterFamily ?? "<unset>"}`,
        fix: "Set tokenizerFamily on both catalog entries",
      });
    } else if (targetFamily !== drafterFamily) {
      checks.push({
        id: `${target.id}:tokenizer`,
        status: "fail",
        label: `${target.displayName} tokenizer parity`,
        detail: `Mismatch — target=${targetFamily} drafter=${drafterFamily}. Speculative decode requires shared vocab.`,
        fix: `Repair catalog so drafter ${dflash.drafterModelId} uses tokenizerFamily=${targetFamily}`,
      });
    } else {
      checks.push({
        id: `${target.id}:tokenizer`,
        status: "pass",
        label: `${target.displayName} tokenizer parity`,
        detail: `Both target and drafter use tokenizerFamily=${targetFamily}`,
      });
    }

    // Drafter↔target checkpoint-hash parity. The drafter must have been
    // distilled against the exact text checkpoint it ships with (training
    // AGENTS.md §2). The bundle's `dflash/target-meta.json` records the
    // drafter's `targetCheckpointSha256` and whether it matches the
    // shipped text GGUF's sha256. A missing meta file → `warn` (legacy /
    // custom bundle); an explicit mismatch → `fail`.
    if (targetInstalled) {
      const meta = readTargetMeta(installedById.get(target.id));
      if (!meta) {
        checks.push({
          id: `${target.id}:checkpoint-parity`,
          status: "warn",
          label: `${target.displayName} drafter↔target checkpoint`,
          detail:
            "No dflash/target-meta.json in the installed bundle — cannot verify the drafter was distilled against this text checkpoint.",
          fix: "Reinstall the bundle from elizaos/eliza-1-* (publish writes target-meta.json).",
        });
      } else if (meta.drafter?.matchesTargetCheckpoint === true) {
        checks.push({
          id: `${target.id}:checkpoint-parity`,
          status: "pass",
          label: `${target.displayName} drafter↔target checkpoint`,
          detail: `Drafter was distilled against this text checkpoint (sha256 ${meta.drafter.targetCheckpointSha256 ?? "?"}).`,
        });
      } else {
        const recorded = meta.drafter?.targetCheckpointSha256 ?? "<unrecorded>";
        checks.push({
          id: `${target.id}:checkpoint-parity`,
          status: "fail",
          label: `${target.displayName} drafter↔target checkpoint`,
          detail: `Drafter's recorded target checkpoint (${recorded}) does not match the shipped text GGUF. Acceptance will collapse — the drafter was distilled against a different checkpoint.`,
          fix: `Re-distill the ${dflash.drafterModelId} drafter against this text checkpoint (packages/training/scripts/distill_dflash_drafter.py) and republish the bundle.`,
        });
      }
    }
  }

  // Live acceptance-rate probe. Only meaningful if the server is currently
  // running with a target loaded; otherwise the doctor reports "no traffic".
  if (runtime.enabled && dflashLlamaServer.hasLoadedModel()) {
    let metrics: DflashMetricsSnapshot | null = null;
    try {
      metrics = await dflashLlamaServer.getMetrics();
    } catch {
      metrics = null;
    }
    if (!metrics) {
      checks.push({
        id: "acceptance-rate",
        status: "warn",
        label: "Acceptance rate",
        detail:
          "Server loaded but /metrics returned no speculative counters yet (no recent traffic).",
      });
    } else if (metrics.drafted === 0) {
      checks.push({
        id: "acceptance-rate",
        status: "warn",
        label: "Acceptance rate",
        detail: "Server loaded but drafter has not produced any tokens yet.",
      });
    } else {
      const rate = metrics.acceptanceRate;
      const status: DflashDoctorStatus =
        rate >= 0.5 ? "pass" : rate >= 0.25 ? "warn" : "fail";
      checks.push({
        id: "acceptance-rate",
        status,
        label: "Acceptance rate",
        detail: `${(rate * 100).toFixed(1)}% (drafted=${metrics.drafted}, accepted=${metrics.accepted}, decoded=${metrics.decoded})`,
        fix:
          status === "fail"
            ? "Acceptance below 25% — verify drafter and target share a tokenizer family and that the drafter is the matched DFlash distill."
            : undefined,
      });
    }
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  };
}
