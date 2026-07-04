/**
 * Confirmation helpers for destructive music actions.
 *
 * The action handlers share this wrapper so playlist, queue, transport, and
 * download operations use the same pending-confirmation contract.
 */
import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { gateDestructiveConfirmation } from "@elizaos/core";

type OptionsRecord = Record<string, unknown>;

export function mergedOptions(options?: OptionsRecord): OptionsRecord {
  const direct = options ?? {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as OptionsRecord)
      : {};
  return { ...direct, ...parameters };
}

export async function gateMusicConfirmation(args: {
  runtime: IAgentRuntime;
  message: Memory;
  actionName: string;
  pendingKey: string;
  preview: string;
  callback?: HandlerCallback;
}): Promise<"confirmed" | "pending" | "cancelled"> {
  const gate = await gateDestructiveConfirmation({
    runtime: args.runtime,
    message: args.message,
    actionName: args.actionName,
    pendingKey: args.pendingKey,
    prompt: `${args.preview} Reply yes to confirm or no to cancel.`,
    callback: args.callback,
  });
  return gate.status;
}

export function confirmationCancelled(preview: string): ActionResult {
  return {
    success: true,
    text: "Cancelled.",
    data: { cancelled: true, preview },
  };
}

export function confirmationAwaiting(preview: string): ActionResult {
  return {
    success: true,
    text: preview,
    data: { requiresConfirmation: true, preview, awaitingUserInput: true },
  };
}

/** Returns an ActionResult when not confirmed; `null` means proceed. */
export async function requireMusicConfirmation(args: {
  runtime: IAgentRuntime;
  message: Memory;
  actionName: string;
  pendingKey: string;
  preview: string;
  callback?: HandlerCallback;
}): Promise<ActionResult | null> {
  const status = await gateMusicConfirmation(args);
  if (status === "confirmed") {
    return null;
  }
  if (status === "pending") {
    return confirmationAwaiting(
      `${args.preview} Reply yes to confirm or no to cancel.`,
    );
  }
  return confirmationCancelled(args.preview);
}
