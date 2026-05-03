import type { ActionResult, HandlerOptions } from "@elizaos/core";

type OptionsRecord = Record<string, unknown>;

function mergedOptions(options?: HandlerOptions): OptionsRecord {
  const direct = (options ?? {}) as OptionsRecord;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as OptionsRecord)
      : {};
  return { ...direct, ...parameters };
}

export function getActionOptions(options?: HandlerOptions): OptionsRecord {
  return mergedOptions(options);
}

export function isConfirmed(options?: HandlerOptions): boolean {
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
