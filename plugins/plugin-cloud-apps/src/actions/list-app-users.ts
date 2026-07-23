/**
 * Lists the users of a published project through its durable Cloud binding.
 *
 * Chat output intentionally omits IP addresses, user agents, and arbitrary
 * metadata; those remain available in the authenticated dashboard when an
 * owner needs request-level diagnostics.
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
import { getCloudClient, resolveCloudApiKey } from "../client.js";
import {
  readProjectAppIdentity,
  readProjectAppUsers,
} from "../cloud-response-validation.js";
import {
  projectOptionSources,
  projectResolutionMessage,
  resolveProject,
} from "../project-resolution.js";

const ACTION = "LIST_APP_USERS";
const NO_KEY_MESSAGE =
  "Connect Eliza Cloud before asking for a published project's users.";
const ERROR_MESSAGE =
  "I couldn't load that project's users from Eliza Cloud right now.";

function readLimit(
  options: unknown,
): { ok: true; value: number } | { ok: false; message: string } {
  const raw = projectOptionSources(options)[0]?.limit;
  if (raw === undefined) return { ok: true, value: 25 };
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw)
        : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    return {
      ok: false,
      message: "User list limit must be an integer from 1 to 100.",
    };
  }
  return { ok: true, value };
}

export const listAppUsersAction: Action = {
  name: ACTION,
  similes: [
    "LIST_PROJECT_USERS",
    "PROJECT_USERS",
    "WHO_USES_MY_PROJECT",
    "SHOW_APP_USERS",
  ],
  description:
    "List people who have interacted with a published project, including safe usage totals and first/last-seen timestamps. Read-only; omits network identifiers from chat.",
  descriptionCompressed: "List a published project's users (read-only).",
  contexts: ["apps", "projects", "settings"],
  contextGate: { anyOf: ["apps", "projects", "settings"] },
  roleGate: { minRole: "ADMIN" },
  parameters: [
    {
      name: "project",
      description:
        "Optional project name or id. Omit to use the active project.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "limit",
      description: "Maximum users to return (1–100, default 25).",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 100 },
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
    const limit = readLimit(options);
    if (!limit.ok) {
      await callback?.({ text: limit.message, actions: [ACTION] });
      return {
        success: false,
        text: "Invalid app-user limit.",
        userFacingText: limit.message,
        data: { reason: "invalid_input" },
      };
    }

    try {
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
        const reply = `"${project.name}" is not published yet, so it has no Cloud user list.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: false,
          text: "Project has no Cloud binding.",
          userFacingText: reply,
          verifiedUserFacing: true,
          data: { reason: "not_published", projectId: project.id },
        };
      }

      const [appResponse, usersResponse] = await Promise.all([
        client.getApp(project.cloudAppId),
        client.listAppUsers(project.cloudAppId, { limit: limit.value }),
      ]);
      const app = readProjectAppIdentity(appResponse, project.cloudAppId);
      const users = readProjectAppUsers(
        usersResponse,
        project.cloudAppId,
        limit.value,
      );
      const safeUsers = users.users.map((user) => ({
        userId: user.user_id,
        signupSource: user.signup_source,
        totalRequests: user.total_requests,
        totalCreditsUsed: user.total_credits_used,
        firstSeenAt: user.first_seen_at,
        lastSeenAt: user.last_seen_at,
      }));
      const reply =
        safeUsers.length === 0
          ? `"${project.name}" has no users yet.`
          : [
              `"${project.name}" users (${users.pagination.total} returned):`,
              ...safeUsers
                .slice(0, 10)
                .map(
                  (user) =>
                    `• ${user.userId} — ${user.totalRequests} requests — last seen ${user.lastSeenAt}`,
                ),
              ...(safeUsers.length > 10
                ? [`• …and ${safeUsers.length - 10} more`]
                : []),
            ].join("\n");
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Fetched ${safeUsers.length} users for ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: project.cloudAppId,
          },
          app: {
            id: app.id,
            name: app.name,
            slug: app.slug,
          },
          users: safeUsers,
          pagination: users.pagination,
        },
      };
    } catch (err) {
      // error-policy:J1 action boundary returns an observable planner failure.
      logger.error(
        { error: err },
        "[LIST_APP_USERS] Failed to read project users",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "Failed to fetch project users.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },
};

export default listAppUsersAction;
