/**
 * BACKUP_APP (#10204) — export a portable, secret-free config snapshot of one of
 * the user's Cloud apps so it can be saved and recreated later. Read-only.
 */

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

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY.";

export const backupAppAction: Action = {
  name: "BACKUP_APP",
  similes: ["EXPORT_APP", "SAVE_APP_CONFIG", "APP_BACKUP", "EXPORT_APP_CONFIG"],
  description:
    "Export a portable config snapshot (backup) of one of the user's Eliza Cloud apps so it can be saved and recreated later. Use when the user wants to back up / export an app's configuration.",
  descriptionCompressed: "Export a config backup snapshot of a Cloud app.",
  contexts: ["settings", "apps"],
  contextGate: { anyOf: ["settings", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["BACKUP_APP"] });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    const { app, available } = reference
      ? await resolveApp(client, reference)
      : { app: null, available: [] as string[] };
    if (!app) {
      const msg =
        available.length === 0
          ? "You don't have any apps to back up yet."
          : `Which app should I back up? Your apps are: ${available.join(", ")}.`;
      await callback?.({ text: msg, actions: ["BACKUP_APP"] });
      return {
        success: false,
        text: "App not found.",
        userFacingText: msg,
        data: { reason: "not_found" },
      };
    }

    try {
      const { backup } = await client.exportAppBackup(app.id);
      const reply = `Backed up "${app.name}" — a config snapshot (v${backup.version}, no secrets) you can save and restore later. Monetization: ${backup.monetization.enabled ? `on, ${backup.monetization.inference_markup_percentage}% inference markup` : "off"}.`;
      await callback?.({ text: reply, actions: ["BACKUP_APP"] });
      return {
        success: true,
        text: `Exported backup for ${app.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        // The full snapshot is returned so the caller can persist it (fact/file).
        data: { backup, app: { id: app.id, name: app.name } },
      };
    } catch (err) {
      logger.warn(
        `[BACKUP_APP] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't export that backup right now.";
      await callback?.({ text: msg, actions: ["BACKUP_APP"] });
      return {
        success: false,
        text: "Backup failed.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "back up my Acme Bot app" } },
      {
        name: "{{agent}}",
        content: {
          text: 'Backed up "Acme Bot" — a config snapshot (v1, no secrets) you can save and restore later. Monetization: off.',
          actions: ["BACKUP_APP"],
        },
      },
    ],
  ],
};
