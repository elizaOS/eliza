/**
 * Composes runtime-configured and shape-based redaction for shell boundaries.
 *
 * Character secrets may be ordinary strings with no recognizable credential
 * shape, so pattern redaction alone is insufficient.
 */
import { type IAgentRuntime, redactSensitiveText } from "@elizaos/core";

export function redactShellText(runtime: IAgentRuntime, text: string): string {
  return redactSensitiveText(runtime.redactSecrets(text), { mode: "tools" });
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
