/**
 * Composes runtime-configured and shape-based redaction for shell boundaries.
 *
 * Character secrets may be ordinary strings with no recognizable credential
 * shape, so pattern redaction alone is insufficient.
 */
import {
  ElizaError,
  type IAgentRuntime,
  redactSensitiveText,
} from "@elizaos/core";

export function redactShellText(runtime: IAgentRuntime, text: string): string {
  if (typeof runtime.redactSecrets !== "function") {
    throw new ElizaError("Shell output redaction is unavailable", {
      code: "SHELL_REDACTION_UNAVAILABLE",
    });
  }
  const runtimeRedacted = runtime.redactSecrets(text);
  return redactSensitiveText(runtimeRedacted, { mode: "tools" });
}

export function resolveShellRedactionOverlapChars(
  runtime: IAgentRuntime,
  minimum: number,
): number {
  const configuredSecrets = runtime.character?.settings?.secrets;
  if (!configuredSecrets || typeof configuredSecrets !== "object") {
    return minimum;
  }
  return Object.values(configuredSecrets).reduce<number>(
    (maximum, value) =>
      typeof value === "string" ? Math.max(maximum, value.length) : maximum,
    minimum,
  );
}

export function redactShellValue<T>(runtime: IAgentRuntime, value: T): T {
  if (typeof value === "string") return redactShellText(runtime, value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactShellValue(runtime, item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactShellValue(runtime, item),
      ]),
    ) as T;
  }
  return value;
}
