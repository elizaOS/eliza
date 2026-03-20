/**
 * PROVISION_CLOUD_AGENT — Deploys an elizaOS agent to ElizaCloud.
 *
 * Creates a container, waits for deployment, connects bridge, starts backup.
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
import type { CloudContainerService } from "../services/cloud-container";
import type { CloudBridgeService } from "../services/cloud-bridge";
import type { CloudBackupService } from "../services/cloud-backup";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CreateContainerRequest } from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import { collectEnvVars } from "../utils/forwarded-settings";

function extractParams(message: Memory, options?: Record<string, unknown>): Record<string, unknown> {
  if (options && Object.keys(options).length > 0) return options;
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
    "Deploy an elizaOS agent to ElizaCloud. Provisions a container, waits for deployment, connects the bridge, and starts auto-backup.",
  similes: ["deploy agent to cloud", "launch cloud agent", "start remote agent", "provision container"],
  tags: ["cloud", "container", "deployment"],
  parameters: [
    { name: "name", description: "Human-readable name for the cloud agent", required: true, schema: { type: "string" } },
    { name: "project_name", description: "Unique project identifier (lowercase, no spaces)", required: true, schema: { type: "string" } },
    { name: "description", description: "Optional description", required: false, schema: { type: "string" } },
    { name: "environment_vars", description: "Additional environment variables", required: false, schema: { type: "object" } },
    { name: "auto_backup", description: "Enable periodic auto-backup (default: true)", required: false, schema: { type: "boolean" } },
  ],

  async validate(runtime: IAgentRuntime): Promise<boolean> {
    const auth = await runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    return !!auth?.isAuthenticated();
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> {
    const auth = await runtime.getService("CLOUD_AUTH") as CloudAuthService;
    const containers = await runtime.getService("CLOUD_CONTAINER") as CloudContainerService;
    const bridge = await runtime.getService("CLOUD_BRIDGE") as CloudBridgeService | undefined;
    const backup = await runtime.getService("CLOUD_BACKUP") as CloudBackupService | undefined;

    if (!auth?.isAuthenticated() || !containers) {
      return { success: false, error: "ElizaCloud not authenticated or container service unavailable" };
    }

    const params = extractParams(message, options);
    if (!params.name || !params.project_name) {
      return { success: false, error: "Missing required parameters: name and project_name" };
    }

    const notify = async (text: string) => { if (callback) await callback({ text, actions: ["PROVISION_CLOUD_AGENT"] }); };
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
      environment_vars: { ...collectEnvVars(runtime), ...(params.environment_vars as Record<string, string> | undefined) },
      health_check_path: "/health",
    };

    const created = await containers.createContainer(request);
    const id = created.data.id;
    await notify(`Container created (id: ${id}). Credits: -$${created.creditsDeducted.toFixed(2)} ($${created.creditsRemaining.toFixed(2)} remaining).`);

    const running = await containers.waitForDeployment(id);
    await notify(`Container running at ${running.load_balancer_url}`);

    if (bridge) {
      await bridge.connect(id);
      logger.info(`[PROVISION] Bridge connected to ${id}`);
    }

    const autoBackup = params.auto_backup !== false;
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
