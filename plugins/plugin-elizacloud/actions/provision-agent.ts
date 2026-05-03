/**
 * PROVISION_CLOUD_AGENT — Deploys an ElizaOS agent to ElizaCloud.
 *
 * Creates a container, waits for deployment, connects bridge, starts backup.
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
import { logger } from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudBackupService } from "../services/cloud-backup";
import type { CloudBridgeService } from "../services/cloud-bridge";
import type { CloudContainerService } from "../services/cloud-container";
import type { CreateContainerRequest } from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import { collectEnvVars } from "../utils/forwarded-settings";
import { confirmationRequired, isConfirmed, mergedOptions } from "./confirmation";

function extractParams(message: Memory, options?: HandlerOptions): Record<string, unknown> {
  const params = mergedOptions(options);
  if (Object.keys(params).length > 0) return params;
  const meta = message.metadata as Record<string, unknown> | undefined;
  if (meta?.actionParams) return meta.actionParams as Record<string, unknown>;
  // Regex fallback from free-text
  const text = (message.content as { text?: string })?.text ?? "";
  const name = text.match(/name[:\s]+["']?([^"',]+)["']?/i)?.[1]?.trim();
  const project = text.match(/project[:\s]+["']?([^"',\s]+)["']?/i)?.[1]?.trim();
  return { name, project_name: project };
}

export const provisionCloudAgentAction: Action = {
  name: "PROVISION_CLOUD_AGENT",
  description:
    "Deploy an ElizaOS agent to ElizaCloud. Provisions a container, waits for deployment, connects the bridge, and starts auto-backup.",
  descriptionCompressed:
    "Deploy agent to ElizaCloud. Provisions container, connects bridge, starts backup.",
  similes: [
    "deploy agent to cloud",
    "launch cloud agent",
    "start remote agent",
    "provision container",
  ],
  tags: ["cloud", "container", "deployment"],
  parameters: [
    {
      name: "name",
      description: "Human-readable name for the cloud agent",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "project_name",
      description: "Unique project identifier (lowercase, no spaces)",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "Optional description",
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
      name: "auto_backup",
      description: "Enable periodic auto-backup (default: true)",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "confirmed",
      description: "Must be true to provision the cloud agent after preview.",
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
    const __avKeywords = ["provision", "cloud"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:provision|cloud)\b/i;
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
      const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
      return !!auth?.isAuthenticated();
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
    const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService;
    const containers = runtime.getService("CLOUD_CONTAINER") as CloudContainerService;
    const bridge = runtime.getService("CLOUD_BRIDGE") as CloudBridgeService | undefined;
    const backup = runtime.getService("CLOUD_BACKUP") as CloudBackupService | undefined;

    if (!auth?.isAuthenticated() || !containers) {
      return {
        success: false,
        error: "ElizaCloud not authenticated or container service unavailable",
      };
    }

    const params = extractParams(message, options);
    if (!params.name || !params.project_name) {
      return {
        success: false,
        error: "Missing required parameters: name and project_name",
      };
    }

    const autoBackup = params.auto_backup !== false;
    const preview = [
      "Confirmation required before provisioning Eliza Cloud agent:",
      `Name: ${String(params.name)}`,
      `Project: ${String(params.project_name)}`,
      `Auto-backup: ${autoBackup ? "enabled" : "disabled"}`,
    ].join("\n");
    if (!isConfirmed(options)) {
      await callback?.({ text: preview, actions: ["PROVISION_CLOUD_AGENT"] });
      return confirmationRequired(preview, {
        name: String(params.name),
        project_name: String(params.project_name),
        auto_backup: autoBackup,
      });
    }

    const notify = async (text: string) => {
      if (callback) await callback({ text, actions: ["PROVISION_CLOUD_AGENT"] });
    };
    await notify(`Provisioning cloud agent "${params.name}"... This typically takes 8-12 minutes.`);

    const defs = DEFAULT_CLOUD_CONFIG.container;
    const request: CreateContainerRequest = {
      name: params.name as string,
      project_name: params.project_name as string,
      description: params.description as string | undefined,
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

    const created = await containers.createContainer(request);
    const id = created.data.id;
    await notify(
      `Container created (id: ${id}). Credits: -$${created.creditsDeducted.toFixed(2)} ($${created.creditsRemaining.toFixed(2)} remaining).`
    );

    const running = await containers.waitForDeployment(id);
    await notify(`Container running at ${running.load_balancer_url}`);

    if (bridge) {
      await bridge.connect(id);
      logger.info(`[PROVISION] Bridge connected to ${id}`);
    }

    if (autoBackup && backup) backup.scheduleAutoBackup(id);

    await notify(`Agent "${params.name}" deployed.${autoBackup ? " Auto-backup enabled." : ""}`);

    return {
      success: true,
      text: `Cloud agent "${params.name}" deployed`,
      data: {
        containerId: id,
        containerUrl: running.load_balancer_url,
        status: running.status,
        creditsDeducted: created.creditsDeducted,
        creditsRemaining: created.creditsRemaining,
        bridgeConnected: bridge?.getConnectionState(id) === "connected",
        autoBackupEnabled: autoBackup,
      },
    };
  },
};
