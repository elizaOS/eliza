import type { ActionResult, HandlerOptions } from "@elizaos/core";

type OptionsRecord = Record<string, unknown>;

export function mergedOptions(options?: HandlerOptions): OptionsRecord {
  const direct = (options ?? {}) as OptionsRecord;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as OptionsRecord)
      : {};
  return { ...direct, ...parameters };
}

export function isConfirmed(options?: HandlerOptions): boolean {
  const raw = mergedOptions(options).confirmed;
  return raw === true || raw === "true";
}

export function confirmationRequired(preview: string, data: OptionsRecord): ActionResult {
  return {
    success: false,
    text: preview,
    data: { requiresConfirmation: true, preview, ...data },
  };
}
