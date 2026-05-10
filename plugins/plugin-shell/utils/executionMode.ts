import type { IAgentRuntime } from "@elizaos/core";

export type RuntimeExecutionMode = "cloud" | "local-safe" | "local-yolo";
/** @deprecated Use {@link RuntimeExecutionMode}. */
export type LocalExecutionMode = "local-safe" | "local-yolo";

const KNOWN_MODES: ReadonlySet<RuntimeExecutionMode> = new Set([
  "cloud",
  "local-safe",
  "local-yolo",
]);

function normalizeMode(value: unknown): RuntimeExecutionMode | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return KNOWN_MODES.has(trimmed as RuntimeExecutionMode)
    ? (trimmed as RuntimeExecutionMode)
    : null;
}

export function resolveRuntimeExecutionMode(
  runtime?: Pick<IAgentRuntime, "getSetting"> | null,
): RuntimeExecutionMode {
  const candidates: unknown[] = [
    runtime?.getSetting?.("ELIZA_RUNTIME_MODE"),
    runtime?.getSetting?.("RUNTIME_MODE"),
    runtime?.getSetting?.("LOCAL_RUNTIME_MODE"),
    process.env.ELIZA_RUNTIME_MODE,
    process.env.RUNTIME_MODE,
    process.env.LOCAL_RUNTIME_MODE,
  ];
  for (const candidate of candidates) {
    const resolved = normalizeMode(candidate);
    if (resolved) return resolved;
  }
  return "local-yolo";
}

export function resolveLocalExecutionMode(
  runtime?: Pick<IAgentRuntime, "getSetting"> | null,
): LocalExecutionMode {
  const mode = resolveRuntimeExecutionMode(runtime);
  return mode === "local-safe" ? "local-safe" : "local-yolo";
}

export function shouldUseSandboxExecution(
  runtime?: Pick<IAgentRuntime, "getSetting"> | null,
): boolean {
  return resolveRuntimeExecutionMode(runtime) === "local-safe";
}

export function isCloudExecutionMode(
  runtime?: Pick<IAgentRuntime, "getSetting"> | null,
): boolean {
  return resolveRuntimeExecutionMode(runtime) === "cloud";
}
