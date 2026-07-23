/**
 * Deactivates a published project while preserving its Project↔Cloud binding.
 *
 * Unpublish is reversible but immediately removes public availability, so it
 * uses the shared two-turn confirmation machine. A confirm executes only the
 * frozen project/app ids captured on the first turn.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getProjectById, logger } from "@elizaos/core";
import { getCloudClient, resolveCloudApiKey } from "../client.js";
import {
  projectResolutionMessage,
  resolveProject,
} from "../project-resolution.js";
import { invalidateAppsCache } from "../providers/cloud-apps.js";
import {
  confirmationRoomId,
  confirmTargetMismatchMessage,
  conflictingConfirmTarget,
  deleteCloudAppConfirmation,
  findPendingCloudAppConfirmation,
  pendingExpired,
  persistCloudAppConfirmation,
  readStructuredConfirmation,
} from "../safety.js";

const ACTION = "UNPUBLISH_PROJECT";
const NO_KEY_MESSAGE = "Connect Eliza Cloud before unpublishing a project.";
const NO_PENDING_MESSAGE =
  "There is no pending project-unpublish confirmation in this conversation. Tell me which project to unpublish first.";
const ERROR_MESSAGE =
  "I couldn't unpublish that project from Eliza Cloud right now.";
const PROJECT_CONFIRM_KEYS = [
  "project",
  "projectName",
  "projectId",
  "name",
  "id",
  "app",
  "appName",
  "appId",
] as const;

export const unpublishProjectAction: Action = {
  name: ACTION,
  similes: [
    "TAKE_PROJECT_OFFLINE",
    "DEACTIVATE_PROJECT",
    "STOP_PUBLISHING_PROJECT",
    "UNPUBLISH_APP",
  ],
  description:
    "Make a published project unavailable without deleting its Cloud record, hosting versions, analytics, earnings, or durable project binding. Requires a second-turn structured confirmation.",
  descriptionCompressed:
    "Unpublish a project but preserve its Cloud record and binding (confirm).",
  contexts: ["apps", "projects", "settings"],
  contextGate: { anyOf: ["apps", "projects", "settings"] },
  roleGate: { minRole: "ADMIN" },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "project",
      description:
        "Optional project name or id. Omit to use the active project.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirm",
      description:
        "Set true only when the user confirms the pending unpublish prompt; false cancels.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    try {
      const roomId = confirmationRoomId(runtime, message);
      const confirmation = readStructuredConfirmation(options);
      const pending = await findPendingCloudAppConfirmation(
        runtime,
        roomId,
        ACTION,
      );

      if (confirmation !== null) {
        if (!pending) {
          await callback?.({ text: NO_PENDING_MESSAGE, actions: [ACTION] });
          return {
            success: false,
            text: "No pending unpublish confirmation.",
            userFacingText: NO_PENDING_MESSAGE,
            data: { reason: "no_pending_confirmation" },
          };
        }
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        if (confirmation === false) {
          const reply = "Canceled. The project is still published.";
          await callback?.({ text: reply, actions: [ACTION] });
          return {
            success: true,
            text: reply,
            userFacingText: reply,
            verifiedUserFacing: true,
            data: { unpublished: false, canceled: true },
          };
        }
        if (pendingExpired(pending)) {
          const reply =
            "That unpublish confirmation expired. Nothing changed; ask me to unpublish the project again.";
          await callback?.({ text: reply, actions: [ACTION] });
          return {
            success: false,
            text: "Pending unpublish confirmation expired.",
            userFacingText: reply,
            verifiedUserFacing: true,
            data: { reason: "confirmation_expired", unpublished: false },
          };
        }

        const conflict = conflictingConfirmTarget(
          options,
          {
            id: pending.metadata.projectId,
            name: pending.metadata.appName,
            aliases: [pending.metadata.appSlug, pending.metadata.appId].filter(
              (value): value is string => typeof value === "string",
            ),
          },
          PROJECT_CONFIRM_KEYS,
        );
        if (conflict !== null) {
          const reply = confirmTargetMismatchMessage(
            conflict,
            "unpublish",
            pending.metadata.appName,
          );
          await callback?.({ text: reply, actions: [ACTION] });
          return {
            success: false,
            text: "Confirmation targeted a different project.",
            userFacingText: reply,
            verifiedUserFacing: true,
            data: {
              reason: "confirm_target_mismatch",
              unpublished: false,
              requested: conflict,
            },
          };
        }

        const project = pending.metadata.projectId
          ? getProjectById(pending.metadata.projectId)
          : null;
        if (!project || project.cloudAppId !== pending.metadata.appId) {
          const reply =
            "The project binding changed after the confirmation prompt, so I did nothing. Check the project and try again.";
          await callback?.({ text: reply, actions: [ACTION] });
          return {
            success: false,
            text: "Project binding changed before unpublish.",
            userFacingText: reply,
            verifiedUserFacing: true,
            data: { reason: "binding_changed", unpublished: false },
          };
        }

        await client.updateApp(pending.metadata.appId, {
          is_active: false,
        });
        invalidateAppsCache(runtime);
        const reply = `"${project.name}" is unpublished. Its Cloud record, hosting versions, analytics, earnings, and project binding are preserved for republishing.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: `Unpublished project ${project.name}.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            project: {
              id: project.id,
              name: project.name,
              cloudAppId: project.cloudAppId,
            },
            unpublished: true,
            bindingPreserved: true,
          },
        };
      }

      if (pending) {
        const reply = `Unpublishing "${pending.metadata.appName}" is still waiting for confirmation. Confirm or cancel that request.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: "Awaiting structured unpublish confirmation.",
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            confirmationRequired: true,
            projectId: pending.metadata.projectId,
            cloudAppId: pending.metadata.appId,
          },
        };
      }

      const resolution = resolveProject(message, options);
      if (!resolution.project) {
        const reply = projectResolutionMessage(resolution);
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: false,
          text: "Project could not be resolved.",
          userFacingText: reply,
          data: { reason: resolution.reason },
        };
      }
      const project = resolution.project;
      if (!project.cloudAppId) {
        const reply = `"${project.name}" is not published, so there is nothing to unpublish.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: `Project ${project.name} is already local only.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            project: { id: project.id, name: project.name },
            unpublished: false,
            alreadyUnpublished: true,
          },
        };
      }
      const app = (await client.getApp(project.cloudAppId)).app;
      if (!app.is_active) {
        const reply = `"${project.name}" is already unpublished; its Cloud binding is preserved.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: `Project ${project.name} is already unpublished.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            project: {
              id: project.id,
              name: project.name,
              cloudAppId: project.cloudAppId,
            },
            unpublished: false,
            alreadyUnpublished: true,
          },
        };
      }

      await persistCloudAppConfirmation(runtime, {
        roomId,
        action: ACTION,
        appId: app.id,
        appName: project.name,
        appSlug: app.slug,
        projectId: project.id,
      });
      const reply =
        `Unpublishing "${project.name}" will take its public URL offline, but keeps the Cloud record, hosting versions, analytics, earnings, and project binding. ` +
        `To continue, confirm unpublish ${project.name}.`;
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Awaiting confirmation to unpublish ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: project.cloudAppId,
          },
          confirmationRequired: true,
          unpublished: false,
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary returns an observable planner failure.
      logger.error(
        { error: err },
        "[UNPUBLISH_PROJECT] Project unpublish failed",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "Failed to unpublish project.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error", unpublished: false },
      };
    }
  },
};

export default unpublishProjectAction;
