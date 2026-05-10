export type LocalExecutionMode = "local-safe" | "local-yolo";

const SAFE_MODE = "local-safe";

function normalizeExecutionMode(value: unknown): LocalExecutionMode {
  return typeof value === "string" && value.trim() === SAFE_MODE
    ? SAFE_MODE
    : "local-yolo";
}

export function resolveLocalExecutionMode(
  source?: { getSetting?: (key: string) => unknown } | null,
): LocalExecutionMode {
  const setting =
    source?.getSetting?.("ELIZA_RUNTIME_MODE") ??
    source?.getSetting?.("RUNTIME_MODE") ??
    source?.getSetting?.("LOCAL_RUNTIME_MODE") ??
    process.env.ELIZA_RUNTIME_MODE ??
    process.env.RUNTIME_MODE ??
    process.env.LOCAL_RUNTIME_MODE;
  return normalizeExecutionMode(setting);
}

export function shouldUseSandboxExecution(
  source?: { getSetting?: (key: string) => unknown } | null,
): boolean {
  return resolveLocalExecutionMode(source) === SAFE_MODE;
}
