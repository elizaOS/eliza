import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { gateDestructiveConfirmation } from "@elizaos/core";

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

/** @deprecated LLM `confirmed` is never authoritative. */
export function isConfirmed(_options?: HandlerOptions): boolean {
  return false;
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

export async function requireShopifyConfirmation(args: {
  runtime: IAgentRuntime;
  message: Memory;
  actionName: string;
  pendingKey: string;
  preview: string;
  callback?: HandlerCallback;
}): Promise<ActionResult | null> {
  const gate = await gateDestructiveConfirmation({
    runtime: args.runtime,
    message: args.message,
    actionName: args.actionName,
    pendingKey: args.pendingKey,
    prompt: `${args.preview} Reply yes to confirm or no to cancel.`,
    callback: args.callback,
  });
  if (gate.status === "confirmed") return null;
  if (gate.status === "pending") {
    return {
      success: true,
      text: `${args.preview} Reply yes to confirm or no to cancel.`,
      data: { requiresConfirmation: true, preview: args.preview, awaitingUserInput: true },
    };
  }
  return { success: true, text: "Cancelled.", data: { cancelled: true } };
}
