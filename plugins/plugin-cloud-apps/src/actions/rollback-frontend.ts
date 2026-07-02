/**
 * Frontend deployment management agent actions (#10690).
 *
 * LIST_FRONTEND_DEPLOYMENTS — show an app's frontend versions + which is live.
 * ROLLBACK_FRONTEND         — make a previous frontend deployment live again
 *                             (activating an older immutable deployment). The
 *                             "editing / rolling back" part of the app lifecycle.
 */

import type { AppFrontendDeploymentDto } from "@elizaos/cloud-sdk";
import type { Action, ActionResult, IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  extractAppReference,
  getCloudClient,
  resolveApp,
  resolveCloudApiKey,
} from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY.";

function readOpt(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const o = options as Record<string, unknown>;
  const nested = o.parameters;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : o;
}

/** Pick the deployment to roll back to: an explicit version, else the newest non-active restorable one. */
export function selectRollbackTarget(
  deployments: AppFrontendDeploymentDto[],
  activeId: string | null,
  version?: number,
): AppFrontendDeploymentDto | null {
  const restorable = deployments
    .filter(
      (d) =>
        d.id !== activeId &&
        (d.status === "superseded" ||
          d.status === "ready" ||
          d.status === "active"),
    )
    .sort((a, b) => b.version - a.version);
  if (version !== undefined)
    return restorable.find((d) => d.version === version) ?? null;
  return restorable[0] ?? null;
}

export const listFrontendDeploymentsAction: Action = {
  name: "LIST_FRONTEND_DEPLOYMENTS",
  similes: [
    "SHOW_FRONTEND_VERSIONS",
    "FRONTEND_HISTORY",
    "APP_FRONTEND_DEPLOYMENTS",
  ],
  description:
    "List an Eliza Cloud app's frontend deployment versions and which one is live. Use when the user asks about their app's frontend versions / deploy history.",
  descriptionCompressed:
    "List an app's frontend deployment versions + the live one.",
  contexts: ["settings", "apps"],
  contextGate: { anyOf: ["settings", "apps"] },
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime,
    message,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["LIST_FRONTEND_DEPLOYMENTS"],
      });
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
          ? "You don't have any apps yet."
          : `Which app? Your apps: ${available.join(", ")}.`;
      await callback?.({ text: msg, actions: ["LIST_FRONTEND_DEPLOYMENTS"] });
      return {
        success: false,
        text: "App not found.",
        userFacingText: msg,
        data: { reason: "not_found" },
      };
    }
    try {
      const { deployments, active_deployment_id } =
        await client.listAppFrontendDeployments(app.id);
      const reply =
        deployments.length === 0
          ? `"${app.name}" has no frontend deployments yet.`
          : `"${app.name}" frontend versions:\n${deployments
              .slice()
              .sort((a, b) => b.version - a.version)
              .map(
                (d) =>
                  `• v${d.version} (${d.status})${d.id === active_deployment_id ? " ← live" : ""}`,
              )
              .join("\n")}`;
      await callback?.({ text: reply, actions: ["LIST_FRONTEND_DEPLOYMENTS"] });
      return {
        success: true,
        text: `Listed ${deployments.length} frontend deployments.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: { count: deployments.length, activeId: active_deployment_id },
      };
    } catch (err) {
      logger.warn(
        `[LIST_FRONTEND_DEPLOYMENTS] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't list the frontend deployments right now.";
      await callback?.({ text: msg, actions: ["LIST_FRONTEND_DEPLOYMENTS"] });
      return {
        success: false,
        text: "Failed to list.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "show my Acme Bot frontend versions" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" frontend versions:\n• v3 (active) ← live\n• v2 (superseded)',
          actions: ["LIST_FRONTEND_DEPLOYMENTS"],
        },
      },
    ],
  ],
};

export const rollbackFrontendAction: Action = {
  name: "ROLLBACK_FRONTEND",
  similes: [
    "REVERT_FRONTEND",
    "RESTORE_FRONTEND_VERSION",
    "UNDO_FRONTEND_DEPLOY",
  ],
  description:
    "Roll an Eliza Cloud app's frontend back to a previous deployment (make an earlier version live again). Use when the user wants to revert / undo / roll back an app's frontend to an earlier version.",
  descriptionCompressed: "Roll an app's frontend back to a previous version.",
  contexts: ["settings", "apps"],
  contextGate: { anyOf: ["settings", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "appName",
      description: "Name/slug/id of the app to roll back.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "version",
      description:
        "Specific frontend version number to restore. Omit to roll back to the previous one.",
      required: false,
      schema: { type: "number" },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime,
    message,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["ROLLBACK_FRONTEND"],
      });
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
          ? "You don't have any apps yet."
          : `Which app? Your apps: ${available.join(", ")}.`;
      await callback?.({ text: msg, actions: ["ROLLBACK_FRONTEND"] });
      return {
        success: false,
        text: "App not found.",
        userFacingText: msg,
        data: { reason: "not_found" },
      };
    }

    const rec = readOpt(options);
    const version = typeof rec.version === "number" ? rec.version : undefined;

    try {
      const { deployments, active_deployment_id } =
        await client.listAppFrontendDeployments(app.id);
      const target = selectRollbackTarget(
        deployments,
        active_deployment_id,
        version,
      );
      if (!target) {
        const msg =
          version !== undefined
            ? `I couldn't find a restorable v${version} for "${app.name}".`
            : `"${app.name}" has no earlier frontend version to roll back to.`;
        await callback?.({ text: msg, actions: ["ROLLBACK_FRONTEND"] });
        return {
          success: false,
          text: "No rollback target.",
          userFacingText: msg,
          data: { reason: "no_target" },
        };
      }
      await client.activateAppFrontend(app.id, target.id);
      const reply = `Rolled "${app.name}" frontend back to v${target.version} — it's live now.`;
      await callback?.({ text: reply, actions: ["ROLLBACK_FRONTEND"] });
      return {
        success: true,
        text: `Rolled ${app.name} frontend back to v${target.version}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: app.id, name: app.name },
          activatedVersion: target.version,
          activatedId: target.id,
        },
      };
    } catch (err) {
      logger.warn(
        `[ROLLBACK_FRONTEND] failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      const msg = "I couldn't roll back the frontend right now.";
      await callback?.({ text: msg, actions: ["ROLLBACK_FRONTEND"] });
      return {
        success: false,
        text: "Rollback failed.",
        userFacingText: msg,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "roll back the Acme Bot site, the new one is broken" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Rolled "Acme Bot" frontend back to v2 — it\'s live now.',
          actions: ["ROLLBACK_FRONTEND"],
        },
      },
    ],
  ],
};
