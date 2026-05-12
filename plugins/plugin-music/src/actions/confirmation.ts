import type { ActionResult } from "@elizaos/core";

type OptionsRecord = Record<string, unknown>;

export function mergedOptions(options?: OptionsRecord): OptionsRecord {
  const direct = options ?? {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as OptionsRecord)
      : {};
  return { ...direct, ...parameters };
}

export function isConfirmed(options?: OptionsRecord): boolean {
  const raw = mergedOptions(options).confirmed;
  return raw === true || raw === "true";
}

export function confirmationRequired(
  preview: string,
  data: OptionsRecord,
): ActionResult {
  return {
    success: false,
    text: preview,
    data: { requiresConfirmation: true, preview, ...data },
  };
}
