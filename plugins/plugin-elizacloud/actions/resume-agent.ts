/**
 * RESUME_CLOUD_AGENT — Restore a frozen agent from snapshot.
 *
 * Re-provisions the container, restores state from the most recent (or
 * specified) snapshot, reconnects bridge, resumes auto-backup.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudBackupService } from "../services/cloud-backup";
import type { CloudBridgeService } from "../services/cloud-bridge";
import type { CloudContainerService } from "../services/cloud-container";
import type { AgentSnapshot, CreateContainerRequest } from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import { collectEnvVars } from "../utils/forwarded-settings";
import { confirmationRequired, isConfirmed, mergedOptions } from "./confirmation";

function extractParams(message: Memory, options?: HandlerOptions): Record<string, unknown> {
  const params = mergedOptions(options);
  if (Object.keys(params).length > 0) return params;
  const meta = message.metadata as Record<string, unknown> | undefined;
  return (meta?.actionParams as Record<string, unknown>) ?? {};
}

async function findLatestProjectSnapshot(
  backup: CloudBackupService,
  containers: CloudContainerService,
  projectName: string
): Promise<AgentSnapshot | null> {
  const all = await containers.listContainers();
  const projectIds = all.filter((c) => c.project_name === projectName).map((c) => c.id);
  const snapshots: AgentSnapshot[] = [];
  for (const id of projectIds) {
    snapshots.push(...(await backup.listSnapshots(id)));
  }
  snapshots.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return snapshots[0] ?? null;
}

export const resumeCloudAgentAction: Action = {
  name: "RESUME_CLOUD_AGENT",
  description:
    "Resume a frozen cloud agent from snapshot. Re-provisions, restores state, reconnects bridge.",
  descriptionCompressed: "Resume frozen cloud agent from snapshot.",
  similes: ["resume agent", "unfreeze agent", "restart cloud agent", "restore agent"],
  tags: ["cloud", "container", "restore"],
  parameters: [
    {
      name: "name",
      description: "Name for the restored agent",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "project_name",
      description: "Project identifier (must match original)",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "snapshotId",
      description: "Specific snapshot ID (defaults to latest)",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "environment_vars",
      description: "Additional environment variables",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "confirmed",
      description: "Must be true to resume the cloud agent after preview.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions
  ): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["resume", "cloud"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:resume|cloud)\b/i;
    const __avRegexOk = Boolean(__avText.match(__avRegex));
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (runtime: IAgentRuntime) => {
      return !!(
        runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined
      )?.isAuthenticated();
    };
    try {
      return Boolean(await __avLegacyValidate(runtime));
    } catch {
      return false;
    }
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    const containerSvc = runtime.getService("CLOUD_CONTAINER") as CloudContainerService;
    const bridge = runtime.getService("CLOUD_BRIDGE") as CloudBridgeService | undefined;
    const backup = runtime.getService("CLOUD_BACKUP") as CloudBackupService | undefined;
    const params = extractParams(message, options);

    if (!params.name || !params.project_name) {
      return {
        success: false,
        error: "Missing required parameters: name and project_name",
      };
    }

    const explicitSnapshot =
      typeof params.snapshotId === "string" && params.snapshotId.length > 0
        ? params.snapshotId
        : null;
    const preview = [
      "Confirmation required before resuming Eliza Cloud agent:",
      `Name: ${String(params.name)}`,
      `Project: ${String(params.project_name)}`,
      `Snapshot: ${explicitSnapshot ?? "latest available"}`,
    ].join("\n");
    if (!isConfirmed(options)) {
      await callback?.({ text: preview, actions: ["RESUME_CLOUD_AGENT"] });
      return confirmationRequired(preview, {
        name: String(params.name),
        project_name: String(params.project_name),
        snapshotId: explicitSnapshot,
      });
    }

    const notify = async (text: string) => {
      if (callback) await callback({ text, actions: ["RESUME_CLOUD_AGENT"] });
    };
    await notify(`Resuming cloud agent "${params.name}"...`);

    const defs = DEFAULT_CLOUD_CONFIG.container;
    const request: CreateContainerRequest = {
      name: params.name as string,
      project_name: params.project_name as string,
      port: defs.defaultPort,
      cpu: defs.defaultCpu,
      memory: defs.defaultMemory,
      architecture: defs.defaultArchitecture,
      ecr_image_uri: defs.defaultImage,
      environment_vars: {
        ...collectEnvVars(runtime),
        ...(params.environment_vars as Record<string, string> | undefined),
      },
      health_check_path: "/health",
    };

    const created = await containerSvc.createContainer(request);
    const id = created.data.id;
    await notify(`Container re-provisioned (${id}). Waiting for infrastructure...`);

    const running = await containerSvc.waitForDeployment(id);

    // Restore from snapshot
    let restoredId: string | null = null;
    if (backup) {
      const explicit = explicitSnapshot ?? undefined;
      if (explicit) {
        await backup.restoreSnapshot(id, explicit);
        restoredId = explicit;
      } else {
        const latest = await findLatestProjectSnapshot(
          backup,
          containerSvc,
          params.project_name as string
        );
        if (latest) {
          await backup.restoreSnapshot(id, latest.id);
          restoredId = latest.id;
        }
      }
      backup.scheduleAutoBackup(id);
    }

    if (bridge) await bridge.connect(id);

    await notify(
      `Agent "${params.name}" resumed at ${running.load_balancer_url}.` +
        (restoredId ? ` Restored snapshot ${restoredId}.` : " No snapshot to restore.")
    );

    return {
      success: true,
      text: `Cloud agent "${params.name}" resumed`,
      data: {
        containerId: id,
        containerUrl: running.load_balancer_url,
        restoredSnapshotId: restoredId,
        creditsDeducted: created.creditsDeducted,
        creditsRemaining: created.creditsRemaining,
      },
    };
  },
};
