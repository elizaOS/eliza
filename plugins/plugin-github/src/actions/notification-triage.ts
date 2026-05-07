/**
 * @module notification-triage
 * @description Fetches unread GitHub notifications and returns them sorted
 * by a composite priority score derived from `reason`, subject type, and
 * the notifying repo's `pushed_at` freshness.
 *
 * Read-only — no confirmation gate.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { buildResolvedClient, resolveIdentity } from "../action-helpers.js";
import {
  errorMessage,
  formatRateLimitMessage,
  inspectRateLimit,
} from "../rate-limit.js";
import { type GitHubActionResult, GitHubActions } from "../types.js";

const REASON_SCORES: Record<string, number> = {
  security_advisory: 100,
  team_mention: 70,
  author: 60,
  mention: 55,
  assign: 50,
  review_requested: 80,
  state_change: 20,
  comment: 30,
  subscribed: 10,
  manual: 15,
  invitation: 40,
  ci_activity: 25,
};

const SUBJECT_TYPE_SCORES: Record<string, number> = {
  PullRequest: 20,
  Issue: 15,
  Release: 10,
  Commit: 5,
  Discussion: 8,
};

const NOTIFICATION_TRIAGE_LIMIT = 25;

export interface TriagedNotification {
  id: string;
  reason: string;
  repo: string;
  title: string;
  subjectType: string;
  url: string | null;
  updatedAt: string;
  score: number;
}

function scoreNotification(params: {
  reason: string;
  subjectType: string;
  repoPushedAtMs: number | null;
  nowMs: number;
}): number {
  const base = REASON_SCORES[params.reason] ?? 10;
  const subject = SUBJECT_TYPE_SCORES[params.subjectType] ?? 0;
  let freshness = 0;
  if (params.repoPushedAtMs !== null) {
    const ageHours = (params.nowMs - params.repoPushedAtMs) / (1000 * 60 * 60);
    if (ageHours < 1) freshness = 20;
    else if (ageHours < 6) freshness = 15;
    else if (ageHours < 24) freshness = 10;
    else if (ageHours < 24 * 7) freshness = 5;
  }
  return base + subject + freshness;
}

export { scoreNotification };

export const notificationTriageAction: Action = {
  name: GitHubActions.GITHUB_NOTIFICATION_TRIAGE,
  contexts: ["code", "tasks", "connectors", "automation"],
  contextGate: { anyOf: ["code", "tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  similes: ["TRIAGE_GITHUB_NOTIFICATIONS", "GITHUB_INBOX"],
  description:
    "Returns unread GitHub notifications sorted by a priority score derived from reason, subject type, and repo freshness.",
  descriptionCompressed:
    "return unread GitHub notification sort priority score derive reason, subject type, repo freshness",
  parameters: [
    {
      name: "as",
      description: "Identity to use when reading notifications: user or agent.",
      required: false,
      schema: { type: "string", enum: ["user", "agent"], default: "user" },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const r = buildResolvedClient(runtime, "user");
    return !("error" in r);
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<
    GitHubActionResult<{
      notifications: TriagedNotification[];
      notificationLimit: number;
      totalUnread: number;
    }>
  > => {
    const identity = resolveIdentity(options, "user");
    const resolved = buildResolvedClient(runtime, identity);
    if ("error" in resolved) {
      await callback?.({ text: resolved.error });
      return { success: false, error: resolved.error };
    }

    try {
      const resp =
        await resolved.client.activity.listNotificationsForAuthenticatedUser({
          all: false,
          per_page: 50,
        });
      const notifications = resp.data as Array<{
        id: string;
        reason?: string | null;
        repository?: { full_name?: string | null; pushed_at?: string | null };
        subject?: {
          title?: string | null;
          type?: string | null;
          url?: string | null;
        };
        updated_at: string;
      }>;
      const nowMs = Date.now();
      const triaged: TriagedNotification[] = notifications.map((n) => {
        const repoPushedAt = n.repository?.pushed_at ?? null;
        const repoPushedAtMs =
          typeof repoPushedAt === "string" ? Date.parse(repoPushedAt) : null;
        const reason = typeof n.reason === "string" ? n.reason : "unknown";
        const subjectType =
          typeof n.subject?.type === "string" ? n.subject.type : "Unknown";
        return {
          id: n.id,
          reason,
          repo: n.repository?.full_name ?? "unknown",
          title: n.subject?.title ?? "(untitled)",
          subjectType,
          url: n.subject?.url ?? null,
          updatedAt: n.updated_at,
          score: scoreNotification({
            reason,
            subjectType,
            repoPushedAtMs:
              repoPushedAtMs !== null && Number.isFinite(repoPushedAtMs)
                ? repoPushedAtMs
                : null,
            nowMs,
          }),
        };
      });
      triaged.sort((a, b) => b.score - a.score);
      const boundedTriaged = triaged.slice(0, NOTIFICATION_TRIAGE_LIMIT);
      await callback?.({
        text: `Triaged ${boundedTriaged.length} unread notification(s)`,
      });
      return {
        success: true,
        data: {
          notifications: boundedTriaged,
          notificationLimit: NOTIFICATION_TRIAGE_LIMIT,
          totalUnread: triaged.length,
        },
      };
    } catch (err) {
      const rl = inspectRateLimit(err);
      const message = rl.isRateLimited
        ? formatRateLimitMessage(rl)
        : `GITHUB_NOTIFICATION_TRIAGE failed: ${errorMessage(err)}`;
      logger.warn({ message }, "[GitHub:GITHUB_NOTIFICATION_TRIAGE]");
      await callback?.({ text: message });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What's in my GitHub inbox?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Triaged 7 unread notification(s)" },
      },
    ],
  ],
};
