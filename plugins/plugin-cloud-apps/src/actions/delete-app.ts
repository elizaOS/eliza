/**
 * DELETE_APP — DESTRUCTIVE. Two-phase confirm, connector-agnostic.
 *
 * Deleting an app tears down its container AND its tenant database — irreversible.
 * So this action NEVER deletes on the first ask:
 *   1. First turn ("delete my Acme app"): resolve the app, return a confirmation
 *      prompt naming the exact app + what's destroyed. `deleteApp` is NOT called.
 *   2. Follow-up turn carrying an explicit confirmation token ("delete Acme —
 *      yes"): `client.deleteApp(id)` runs exactly once.
 *
 * The confirm signal is parsed from the user's plain message text via the shared
 * {@link isExplicitConfirmation} helper, so it works the same on every connector
 * and does not rely on a GUI button.
 */

import type { AppDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";
import { confirmationPrompt, isExplicitConfirmation } from "../safety.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can manage your apps.";
const NO_REFERENCE_MESSAGE =
  "Which app would you like to delete? Tell me its name.";
const ERROR_MESSAGE =
  "I couldn't delete that app right now — the Cloud API returned an error. Try again in a moment.";

/** What `deleteApp` destroys — surfaced verbatim in the confirmation prompt. */
const DESTROYED_RESOURCES = ["its running container", "its tenant database"];

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

function confirmTargetFor(app: AppDto): {
  name: string;
  id: string;
  aliases: string[];
} {
  return { name: app.name, id: app.id, aliases: [app.slug] };
}

export const deleteAppAction: Action = {
  name: "DELETE_APP",
  similes: ["REMOVE_APP", "DELETE_MY_APP", "DESTROY_APP", "DELETE_CLOUD_APP"],
  description:
    "Delete an Eliza Cloud app. DESTRUCTIVE: tears down the app's container and tenant database. Requires an explicit confirmation — the first ask only confirms intent. Use when the user asks to delete, remove, or destroy an app.",
  descriptionCompressed: "Delete a Cloud app (destructive; two-step confirm).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["DELETE_APP"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({ text: NO_REFERENCE_MESSAGE, actions: ["DELETE_APP"] });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    let app: AppDto | null;
    let available: string[];
    try {
      ({ app, available } = await resolveApp(client, reference));
    } catch (err) {
      logger.warn(
        `[DELETE_APP] Failed to resolve app "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["DELETE_APP"] });
      return {
        success: false,
        text: "Failed to resolve Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!app) {
      const msg = notFoundMessage(reference, available);
      await callback?.({ text: msg, actions: ["DELETE_APP"] });
      return {
        success: false,
        text: `No app matched "${reference}".`,
        userFacingText: msg,
        data: { reason: "not_found", reference },
      };
    }

    const target = app;
    const confirmTarget = confirmTargetFor(target);
    const messageText = message.content?.text ?? "";

    // Phase 1 — no explicit confirmation in THIS message → ask, do not delete.
    if (!isExplicitConfirmation(messageText, confirmTarget)) {
      const prompt = confirmationPrompt(confirmTarget, DESTROYED_RESOURCES);
      await callback?.({ text: prompt, actions: ["DELETE_APP"] });
      return {
        success: true,
        text: `Awaiting explicit confirmation to delete ${target.name}.`,
        userFacingText: prompt,
        verifiedUserFacing: true,
        data: {
          app: { id: target.id, name: target.name, slug: target.slug },
          deleted: false,
          confirmationRequired: true,
        },
      };
    }

    // Phase 2 — explicit confirmation present → delete exactly once.
    try {
      const result = await client.deleteApp(target.id);
      const reply = `Deleted "${target.name}". Its container and tenant database are gone.`;
      await callback?.({ text: reply, actions: ["DELETE_APP"] });
      return {
        success: true,
        text: result.message || `Deleted ${target.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: target.id, name: target.name, slug: target.slug },
          deleted: true,
          cleaned: result.cleaned,
        },
      };
    } catch (err) {
      logger.warn(
        `[DELETE_APP] deleteApp(${target.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["DELETE_APP"] });
      return {
        success: false,
        text: "Failed to delete Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error", deleted: false },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "delete my Acme Bot app" } },
      {
        name: "{{agent}}",
        content: {
          text: 'This will delete "Acme Bot" (…). This permanently destroys its running container and its tenant database. This can\'t be undone. To go ahead, reply: delete Acme Bot — yes.',
          actions: ["DELETE_APP"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "delete Acme Bot — yes" } },
      {
        name: "{{agent}}",
        content: {
          text: 'Deleted "Acme Bot". Its container and tenant database are gone.',
          actions: ["DELETE_APP"],
        },
      },
    ],
  ],
};

export default deleteAppAction;
