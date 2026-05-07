import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { getCoordinator } from "../services/pty-service.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import { discoverTaskShareOptions } from "../services/task-share.js";
import { resolveTaskThreadTarget } from "./task-thread-target.js";

function artifactTypeForTarget(type: string): string {
  if (type === "preview_url" || type === "artifact_uri") return "share_link";
  if (type === "artifact_path") return "share_path";
  return "workspace";
}

export const taskShareAction: Action = {
  name: "TASK_SHARE",
  contexts: ["tasks", "automation", "agent_internal"],
  contextGate: { anyOf: ["tasks", "automation", "agent_internal"] },
  roleGate: { minRole: "USER" },
  similes: [
    "SHARE_TASK_RESULT",
    "SHOW_TASK_ARTIFACT",
    "VIEW_TASK_OUTPUT",
    "CAN_I_SEE_IT",
    "PULL_IT_UP",
  ],
  description:
    "Discover the best available way to view or share a task result, including artifacts, live preview URLs, workspace paths, and environment share capabilities.",
  descriptionCompressed:
    "Find best way to view/share task result: artifacts, live URLs, paths.",
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Can I see it?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll inspect the task artifacts and preview options.",
          action: "TASK_SHARE",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "How do I view that from a remote computer?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll check the available share and remote-preview options.",
          action: "TASK_SHARE",
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(getCoordinator(runtime));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const access = await requireTaskAgentAccess(runtime, message, "interact");
    if (!access.allowed) {
      if (callback) {
        await callback({ text: access.reason });
      }
      return { success: false, error: "FORBIDDEN", text: access.reason };
    }

    const coordinator = getCoordinator(runtime);
    if (!coordinator) {
      if (callback) {
        await callback({ text: "Coordinator is not available." });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    const params =
      (options?.parameters as Record<string, unknown> | undefined) ?? {};
    const thread = await resolveTaskThreadTarget({
      coordinator,
      message,
      state,
      options: params,
      includeArchived: true,
    });
    if (!thread) {
      if (callback) {
        await callback({ text: "I could not find a task thread to share." });
      }
      return { success: false, error: "THREAD_NOT_FOUND" };
    }

    const discovery = await discoverTaskShareOptions(coordinator, thread.id);
    if (!discovery || discovery.targets.length === 0) {
      const fallback = `I found the task thread "${thread.title}", but I did not find a preview URL or shareable artifact yet.`;
      if (callback) {
        await callback({ text: fallback });
      }
      return {
        success: false,
        error: "NO_SHARE_TARGET",
        text: fallback,
        data: {
          threadId: thread.id,
          shareCapabilities: discovery?.shareCapabilities ?? [],
        },
      };
    }

    const detail = await coordinator.getTaskThread(thread.id);
    const existingKeys = new Set(
      (detail?.artifacts ?? []).map(
        (artifact) =>
          artifact.uri?.trim() ||
          artifact.path?.trim() ||
          `${artifact.artifactType}:${artifact.title}`,
      ),
    );
    for (const target of discovery.targets) {
      const key = target.value.trim();
      if (!key || existingKeys.has(key)) continue;
      await coordinator.taskRegistry.recordArtifact({
        threadId: thread.id,
        artifactType: artifactTypeForTarget(target.type),
        title: target.label,
        ...(target.type === "artifact_path" || target.type === "workspace"
          ? { path: target.value }
          : { uri: target.value }),
        metadata: {
          source: target.source,
          remoteAccessible: target.remoteAccessible,
          discoveredVia: "task-share-action",
        },
      });
      existingKeys.add(key);
    }

    const preferred = discovery.preferredTarget;
    const lines = [
      preferred
        ? `Best available view for "${thread.title}": ${preferred.value}`
        : `I found share options for "${thread.title}".`,
      ...discovery.targets
        .slice(0, 5)
        .map(
          (target) =>
            `- ${target.label}: ${target.value}${target.remoteAccessible ? " (remote-ready)" : ""}`,
        ),
      discovery.shareCapabilities.length > 0
        ? `Environment share capabilities: ${discovery.shareCapabilities.join(", ")}`
        : "No explicit remote-share capability is configured, so local artifact paths and preview URLs are the only confirmed options right now.",
    ].filter(Boolean);
    const responseText = lines.join("\n");

    if (callback) {
      await callback({ text: responseText });
    }
    return {
      success: true,
      text: responseText,
      data: {
        threadId: thread.id,
        preferredTarget: preferred,
        shareCapabilities: discovery.shareCapabilities,
        targetCount: discovery.targets.length,
      },
    };
  },
  parameters: [
    {
      name: "threadId",
      description: "Specific task thread id to inspect.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "sessionId",
      description: "Task session id to resolve to its thread.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "search",
      description: "Search text used to find the task thread to share.",
      descriptionCompressed: "Search text for finding task thread to share.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
