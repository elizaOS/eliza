/**
 * Shared block-activation seam.
 *
 * Both the chat action `WEBSITE_BLOCK` (presentation) and the
 * `BlockRuleWriter` (chat-integration / application) need to flip the
 * OS-level hosts-file block on for a given hostname set + duration.
 *
 * Owning this here breaks the cycle that existed when the writer reached
 * up into `actions/website-block.ts` to invoke the action handler purely
 * for its side effect — the handler is presentation, the writer is
 * application, and the OS-block transaction is domain.
 *
 * The activator wraps `startSelfControlBlock` + `syncWebsiteBlockerExpiryTask`
 * with rollback semantics: if the expiry task can't be scheduled the OS
 * block is stopped before returning a failure.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { startSelfControlBlock, stopSelfControlBlock } from "../engine.js";
import { syncWebsiteBlockerExpiryTask } from "../service.js";

export interface ActivateBlockRequest {
  runtime: IAgentRuntime;
  websites: readonly string[];
  /** `null` = manual / indefinite; positive integer = timed minutes. */
  durationMinutes: number | null;
}

export type ActivateBlockResult =
  | { success: true; endsAt: string | null }
  | { success: false; error: string };

export async function activateBlockRule(
  request: ActivateBlockRequest,
): Promise<ActivateBlockResult> {
  const result = await startSelfControlBlock({
    websites: [...request.websites],
    durationMinutes: request.durationMinutes,
    scheduledByAgentId: String(request.runtime.agentId),
  });
  if (result.success === false) {
    return { success: false, error: result.error };
  }

  if (request.durationMinutes !== null) {
    const taskId = await syncWebsiteBlockerExpiryTask(request.runtime);
    if (!taskId) {
      await stopSelfControlBlock();
      return {
        success: false,
        error:
          "Eliza started the website block but could not schedule its automatic unblock task, so it rolled the block back.",
      };
    }
  }

  return { success: true, endsAt: result.endsAt };
}
