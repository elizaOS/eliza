/**
 * REGENERATE_APP_API_KEY — SECURITY-SENSITIVE. Rotates the app's API key.
 *
 * Rotating invalidates the current key IMMEDIATELY — anything using it stops
 * working until updated — so this action never rotates on the first ask:
 *   1. First turn ("rotate my Acme key"): resolve the app, return a confirmation
 *      prompt spelling out that the previous key dies right away. No rotate call.
 *   2. Follow-up with structured `confirm: true` for the pending prompt:
 *      `client.regenerateAppApiKey(id)` runs exactly once.
 *
 * The new plaintext key is shown EXACTLY ONCE in the reply with a "save it now"
 * warning, and is NEVER logged or placed in the structured `data`/`text` fields
 * (which may be persisted) — only in the user-facing message the connector shows.
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
import {
  confirmationRoomId,
  confirmTargetMismatchMessage,
  conflictingConfirmTarget,
  deleteCloudAppConfirmation,
  findPendingCloudAppConfirmation,
  persistCloudAppConfirmation,
  readStructuredConfirmation,
} from "../safety.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can rotate your app keys.";
const NO_REFERENCE_MESSAGE =
  "Which app's API key would you like to regenerate? Tell me its name.";
const ERROR_MESSAGE =
  "I couldn't rotate that app's API key right now — the Cloud API returned an error. The existing key is unchanged. Try again in a moment.";
const NO_PENDING_CONFIRMATION_MESSAGE =
  "I don't have a pending API-key rotation confirmation for this room. Tell me which app key to rotate first, and I'll ask for confirmation.";
const CANCELED_MESSAGE = "Canceled. No app API key was rotated.";

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

export const regenerateAppApiKeyAction: Action = {
  name: "REGENERATE_APP_API_KEY",
  similes: [
    "ROTATE_KEY",
    "NEW_API_KEY",
    "REGENERATE_API_KEY",
    "RESET_API_KEY",
    "ROTATE_APP_KEY",
  ],
  description:
    "Regenerate (rotate) an Eliza Cloud app's API key. SECURITY-SENSITIVE: invalidates the current key immediately. Requires an explicit confirmation — the first ask only confirms intent. Use when the user asks to rotate, regenerate, reset, or get a new API key for an app.",
  descriptionCompressed:
    "Rotate a Cloud app's API key (security; two-step confirm).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "appName",
      description:
        "Name, slug, or id of the Cloud app whose API key to rotate.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirm",
      description:
        "Follow-up confirmation. Set true only when the user is confirming the pending API-key rotation prompt for this app; set false when canceling.",
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
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["REGENERATE_APP_API_KEY"],
      });
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
      "REGENERATE_APP_API_KEY",
    );

    if (confirmation !== null) {
      if (!pending) {
        await callback?.({
          text: NO_PENDING_CONFIRMATION_MESSAGE,
          actions: ["REGENERATE_APP_API_KEY"],
        });
        return {
          success: false,
          text: "No pending API-key rotation confirmation.",
          userFacingText: NO_PENDING_CONFIRMATION_MESSAGE,
          data: { reason: "no_pending_confirmation", rotated: false },
        };
      }

      await deleteCloudAppConfirmation(runtime, pending.taskId);
      if (confirmation === false) {
        await callback?.({
          text: CANCELED_MESSAGE,
          actions: ["REGENERATE_APP_API_KEY"],
        });
        return {
          success: true,
          text: CANCELED_MESSAGE,
          userFacingText: CANCELED_MESSAGE,
          verifiedUserFacing: true,
          data: { rotated: false, canceled: true },
        };
      }

      const target = {
        id: pending.metadata.appId,
        name: pending.metadata.appName,
        slug: pending.metadata.appSlug ?? pending.metadata.appName,
      };

      // Frozen-target guard: a confirm whose own params name a DIFFERENT app
      // must never rotate the frozen app's key.
      const conflict = conflictingConfirmTarget(options, {
        name: target.name,
        id: target.id,
        aliases: [target.slug],
      });
      if (conflict !== null) {
        const msg = confirmTargetMismatchMessage(
          conflict,
          "API-key rotation",
          target.name,
        );
        await callback?.({ text: msg, actions: ["REGENERATE_APP_API_KEY"] });
        return {
          success: false,
          text: `Confirm named "${conflict}" but the pending rotation was for ${target.name}; refused.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: {
            reason: "confirm_target_mismatch",
            rotated: false,
            requested: conflict,
            pendingTarget: { id: target.id, name: target.name },
          },
        };
      }

      try {
        const result = await client.regenerateAppApiKey(target.id);
        const newKey =
          typeof result.apiKey === "string" && result.apiKey.length > 0
            ? result.apiKey
            : null;

        if (result.success === false || !newKey) {
          const msg = `I rotated the request for "${target.name}", but the Cloud API didn't return a new key. Check your dashboard to confirm the key, then try again if needed.`;
          await callback?.({
            text: msg,
            actions: ["REGENERATE_APP_API_KEY"],
          });
          return {
            success: false,
            text: "Rotation returned no key.",
            userFacingText: msg,
            data: { reason: "no_key_returned", rotated: false },
          };
        }

        const reply =
          `Done — here is the new API key for "${target.name}":\n\n${newKey}\n\n` +
          `Save this now: it won't be shown again, and the old key no longer works. ` +
          `Update anything that used the previous key.`;
        await callback?.({
          text: reply,
          actions: ["REGENERATE_APP_API_KEY"],
        });
        return {
          success: true,
          text: `Regenerated the API key for ${target.name}.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            app: { id: target.id, name: target.name, slug: target.slug },
            rotated: true,
            keyShown: true,
          },
        };
      } catch (err) {
        logger.warn(
          `[REGENERATE_APP_API_KEY] regenerateAppApiKey(${target.id}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await callback?.({
          text: ERROR_MESSAGE,
          actions: ["REGENERATE_APP_API_KEY"],
        });
        return {
          success: false,
          text: "Failed to regenerate API key.",
          userFacingText: ERROR_MESSAGE,
          error: err instanceof Error ? err : new Error(String(err)),
          data: { reason: "error", rotated: false },
        };
      }
    }

    if (pending) {
      const msg =
        `API-key rotation for "${pending.metadata.appName}" is still waiting for confirmation. ` +
        `Reply with a clear confirmation or cancellation.`;
      await callback?.({
        text: msg,
        actions: ["REGENERATE_APP_API_KEY"],
      });
      return {
        success: true,
        text: `Awaiting structured confirmation to rotate the API key for ${pending.metadata.appName}.`,
        userFacingText: msg,
        verifiedUserFacing: true,
        data: {
          app: {
            id: pending.metadata.appId,
            name: pending.metadata.appName,
            slug: pending.metadata.appSlug,
          },
          rotated: false,
          confirmationRequired: true,
        },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({
        text: NO_REFERENCE_MESSAGE,
        actions: ["REGENERATE_APP_API_KEY"],
      });
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
        `[REGENERATE_APP_API_KEY] Failed to resolve app "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({
        text: ERROR_MESSAGE,
        actions: ["REGENERATE_APP_API_KEY"],
      });
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
      await callback?.({ text: msg, actions: ["REGENERATE_APP_API_KEY"] });
      return {
        success: false,
        text: `No app matched "${reference}".`,
        userFacingText: msg,
        data: { reason: "not_found", reference },
      };
    }

    const target = app;
    await persistCloudAppConfirmation(runtime, {
      roomId,
      action: "REGENERATE_APP_API_KEY",
      appId: target.id,
      appName: target.name,
      appSlug: target.slug,
    });
    const prompt =
      `This will regenerate the API key for "${target.name}" (${target.id}). ` +
      `The current key stops working immediately, so any app or integration ` +
      `using it will break until you paste in the new one. This can't be undone. ` +
      `To go ahead, reply that you confirm rotating the key for ${target.name}.`;
    await callback?.({
      text: prompt,
      actions: ["REGENERATE_APP_API_KEY"],
    });
    return {
      success: true,
      text: `Awaiting structured confirmation to rotate the API key for ${target.name}.`,
      userFacingText: prompt,
      verifiedUserFacing: true,
      data: {
        app: { id: target.id, name: target.name, slug: target.slug },
        rotated: false,
        confirmationRequired: true,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "regenerate the API key for Acme Bot" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'This will regenerate the API key for "Acme Bot" (…). The current key stops working immediately, so any app or integration using it will break until you paste in the new one. This can\'t be undone. To go ahead, reply that you confirm rotating the key for Acme Bot.',
          actions: ["REGENERATE_APP_API_KEY"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "I confirm rotating the key for Acme Bot" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Done — here is the new API key for "Acme Bot":\n\neliza_app_…\n\nSave this now: it won\'t be shown again, and the old key no longer works. Update anything that used the previous key.',
          actions: ["REGENERATE_APP_API_KEY"],
        },
      },
    ],
  ],
};

export default regenerateAppApiKeyAction;
