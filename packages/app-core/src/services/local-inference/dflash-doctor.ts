import fs from "node:fs";
import { MODEL_CATALOG } from "./catalog";
import { getDflashRuntimeStatus } from "./dflash-server";
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
    const target = MODEL_CATALOG.find((model) => model.id === targetId);
    const dflash = target?.runtime?.dflash;
    if (!target || !dflash) continue;
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
  }

  return {
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  };
}
