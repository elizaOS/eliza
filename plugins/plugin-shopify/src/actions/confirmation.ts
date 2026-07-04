/**
 * Confirmation gate for Shopify write operations. `requireShopifyConfirmation`
 * wraps the core `gateDestructiveConfirmation`: it returns `null` once the user
 * has confirmed (the caller then proceeds with the mutation), or an
 * `ActionResult` prompting/cancelling otherwise. Every mutating handler
 * (product create/update, inventory adjust, order fulfill) routes through it.
 */
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
      data: {
        requiresConfirmation: true,
        preview: args.preview,
        awaitingUserInput: true,
      },
    };
  }
  return { success: true, text: "Cancelled.", data: { cancelled: true } };
}
