import fs from "node:fs";
import { findCatalogModel, MODEL_CATALOG } from "./catalog";
import {
  type DflashMetricsSnapshot,
  dflashLlamaServer,
  getDflashRuntimeStatus,
} from "./dflash-server";
import { listInstalledModels } from "./registry";

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
  const installedIds = new Set(installed.map((model) => model.id));
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
  }

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
