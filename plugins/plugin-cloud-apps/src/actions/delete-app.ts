/**
 * DELETE_APP — DESTRUCTIVE. Two-phase confirm, connector-agnostic.
 *
 * Deleting an app tears down its container AND its tenant database — irreversible.
 * So this action NEVER deletes on the first ask:
 *   1. First turn ("delete my Acme app"): resolve the app, return a confirmation
 *      prompt naming the exact app + what's destroyed. `deleteApp` is NOT called.
 *   2. Follow-up turn carrying structured `confirm: true` for the pending
 *      prompt: `client.deleteApp(id)` runs exactly once.
 *
 * The handler never parses raw user prose for confirmation. The planner supplies
 * a structured boolean and the action consumes a pending confirmation task.
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
import { removeAppDeployFact } from "../app-facts.js";
import {
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";
import { invalidateAppsCache } from "../providers/cloud-apps.js";
import {
  confirmationPrompt,
  confirmationRoomId,
  deleteCloudAppConfirmation,
  findPendingCloudAppConfirmation,
  persistCloudAppConfirmation,
  readStructuredConfirmation,
} from "../safety.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can manage your apps.";
const NO_REFERENCE_MESSAGE =
  "Which app would you like to delete? Tell me its name.";
const ERROR_MESSAGE =
  "I couldn't delete that app right now — the Cloud API returned an error. Try again in a moment.";
const NO_PENDING_CONFIRMATION_MESSAGE =
  "I don't have a pending delete confirmation for this room. Tell me which app to delete first, and I'll ask for confirmation.";
const CANCELED_MESSAGE = "Canceled. No Cloud app was deleted.";

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
  parameters: [
    {
      name: "appName",
      description: "Name, slug, or id of the Cloud app to delete.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirm",
      description:
        "Follow-up confirmation. Set true only when the user is confirming the pending delete prompt for this app; set false when canceling.",
      required: false,
      schema: { type: "boolean" },
    },
  ],

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

    const roomId = confirmationRoomId(runtime, message);
    const confirmation = readStructuredConfirmation(options);
    const pending = await findPendingCloudAppConfirmation(
      runtime,
      roomId,
      "DELETE_APP",
    );

    if (confirmation !== null) {
      if (!pending) {
        await callback?.({
          text: NO_PENDING_CONFIRMATION_MESSAGE,
          actions: ["DELETE_APP"],
        });
        return {
          success: false,
          text: "No pending delete confirmation.",
          userFacingText: NO_PENDING_CONFIRMATION_MESSAGE,
          data: { reason: "no_pending_confirmation", deleted: false },
        };
      }

      await deleteCloudAppConfirmation(runtime, pending.taskId);
      if (confirmation === false) {
        await callback?.({ text: CANCELED_MESSAGE, actions: ["DELETE_APP"] });
        return {
          success: true,
          text: CANCELED_MESSAGE,
          userFacingText: CANCELED_MESSAGE,
          verifiedUserFacing: true,
          data: { deleted: false, canceled: true },
        };
      }

      const target = {
        id: pending.metadata.appId,
        name: pending.metadata.appName,
        slug: pending.metadata.appSlug ?? pending.metadata.appName,
      };
      try {
        const result = await client.deleteApp(target.id);
        // Any delete attempt can change the app inventory — force the provider to
        // re-fetch so it never serves the just-deleted app from its 60s cache.
        invalidateAppsCache(runtime);

        // The DELETE route runs cleanup with continueOnError and returns HTTP 200
        // with { success:false, errors } on PARTIAL failure (e.g. container
        // teardown failed because the node was unreachable). Don't claim
        // everything is gone in that case — the tenant DB / container may survive.
        if (result.success === false || (result.errors?.length ?? 0) > 0) {
          const detail = result.errors?.length
            ? ` (${result.errors.join("; ")})`
            : "";
          const partial =
            `I hit a problem deleting "${target.name}" — some resources may not ` +
            `have been fully torn down${detail}. Check your Eliza Cloud dashboard ` +
            `to confirm what remains.`;
          await callback?.({ text: partial, actions: ["DELETE_APP"] });
          return {
            success: false,
            text: result.message || `Partial delete for ${target.name}.`,
            userFacingText: partial,
            data: {
              app: { id: target.id, name: target.name, slug: target.slug },
              deleted: false,
              partial: true,
              errors: result.errors ?? [],
              cleaned: result.cleaned,
            },
          };
        }

        // Clean success: purge the durable "app is live" fact so the agent stops
        // recalling the deleted app as live at its old URL.
        await removeAppDeployFact(runtime, message, target.id);
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
    }

    if (pending) {
      const msg =
        `Deletion for "${pending.metadata.appName}" is still waiting for confirmation. ` +
        `Reply with a clear confirmation or cancellation.`;
      await callback?.({ text: msg, actions: ["DELETE_APP"] });
      return {
        success: true,
        text: `Awaiting structured confirmation to delete ${pending.metadata.appName}.`,
        userFacingText: msg,
        verifiedUserFacing: true,
        data: {
          app: {
            id: pending.metadata.appId,
            name: pending.metadata.appName,
            slug: pending.metadata.appSlug,
          },
          deleted: false,
          confirmationRequired: true,
        },
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
    let ambiguous: string[] | undefined;
    try {
      ({ app, available, ambiguous } = await resolveApp(client, reference));
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
      const candidates = ambiguous && ambiguous.length > 1 ? ambiguous : null;
      const msg = candidates
        ? `Which app do you mean? "${reference}" matches ${candidates.length}: ${candidates.join(", ")}. Reply with the exact name so I don't delete the wrong one.`
        : notFoundMessage(reference, available);
      await callback?.({ text: msg, actions: ["DELETE_APP"] });
      return {
        success: false,
        text: candidates
          ? `Ambiguous reference "${reference}" (${candidates.length} matches).`
          : `No app matched "${reference}".`,
        userFacingText: msg,
        data: {
          reason: candidates ? "ambiguous" : "not_found",
          reference,
          ...(candidates ? { candidates } : {}),
        },
      };
    }

    const target = app;
    const confirmTarget = confirmTargetFor(target);
    await persistCloudAppConfirmation(runtime, {
      roomId,
      action: "DELETE_APP",
      appId: target.id,
      appName: target.name,
      appSlug: target.slug,
    });
    const prompt = confirmationPrompt(confirmTarget, DESTROYED_RESOURCES);
    await callback?.({ text: prompt, actions: ["DELETE_APP"] });
    return {
      success: true,
      text: `Awaiting structured confirmation to delete ${target.name}.`,
      userFacingText: prompt,
      verifiedUserFacing: true,
      data: {
        app: { id: target.id, name: target.name, slug: target.slug },
        deleted: false,
        confirmationRequired: true,
      },
    };
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "delete my Acme Bot app" } },
      {
        name: "{{agent}}",
        content: {
          text: 'This will delete "Acme Bot" (…). This permanently destroys its running container and its tenant database. This can\'t be undone. To go ahead, reply that you confirm delete Acme Bot.',
          actions: ["DELETE_APP"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "I confirm deleting Acme Bot" } },
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
