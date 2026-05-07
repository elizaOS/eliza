/**
 * CLOUD_AGENT — Single router for ElizaCloud agent lifecycle and billing ops.
 *
 * Dispatches on `op`:
 *   - "provision"     → create container, wait for deployment, connect bridge, start backup
 *   - "freeze"        → snapshot, disconnect bridge, stop container
 *   - "resume"        → re-provision from snapshot, restore state, reconnect bridge
 *   - "check_credits" → query credit balance, container costs, estimated runtime
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
import type {
  AgentSnapshot,
  CreateContainerRequest,
  CreditBalanceResponse,
  CreditSummaryResponse,
} from "../types/cloud";
import { DEFAULT_CLOUD_CONFIG } from "../types/cloud";
import { collectEnvVars } from "../utils/forwarded-settings";
import { confirmationRequired, isConfirmed, mergedOptions } from "./confirmation";

type CloudAgentOp = "provision" | "freeze" | "resume" | "check_credits";

const VALID_OPS: ReadonlyArray<CloudAgentOp> = ["provision", "freeze", "resume", "check_credits"];
const DAILY_COST_PER_CONTAINER = 0.67;

function readOp(message: Memory, options?: HandlerOptions): CloudAgentOp | null {
  const params = mergedOptions(options);
  const direct = params.op;
  if (typeof direct === "string" && (VALID_OPS as ReadonlyArray<string>).includes(direct)) {
    return direct as CloudAgentOp;
  }
  const meta = (message.metadata as Record<string, unknown> | undefined)?.actionParams as
    | Record<string, unknown>
    | undefined;
  const fromMeta = meta?.op;
  if (typeof fromMeta === "string" && (VALID_OPS as ReadonlyArray<string>).includes(fromMeta)) {
    return fromMeta as CloudAgentOp;
  }
  return null;
}

function readParams(message: Memory, options?: HandlerOptions): Record<string, unknown> {
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

// ─── Op handlers ────────────────────────────────────────────────────────────

async function handleProvision(
  runtime: IAgentRuntime,
  message: Memory,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined
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

  const params = readParams(message, options);
  if (!params.name || !params.project_name) {
    // Free-text fallback parsing for prompt-driven invocations.
    const text = (message.content as { text?: string })?.text ?? "";
    const fallbackName = text.match(/name[:\s]+["']?([^"',]+)["']?/i)?.[1]?.trim();
    const fallbackProject = text.match(/project[:\s]+["']?([^"',\s]+)["']?/i)?.[1]?.trim();
    if (fallbackName) params.name = fallbackName;
    if (fallbackProject) params.project_name = fallbackProject;
  }

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
    await callback?.({ text: preview, actions: ["CLOUD_AGENT"] });
    return confirmationRequired(preview, {
      op: "provision",
      name: String(params.name),
      project_name: String(params.project_name),
      auto_backup: autoBackup,
    });
  }

  const notify = async (text: string) => {
    if (callback) await callback({ text, actions: ["CLOUD_AGENT"] });
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
    logger.info(`[CLOUD_AGENT/provision] Bridge connected to ${id}`);
  }

  if (autoBackup && backup) backup.scheduleAutoBackup(id);

  await notify(`Agent "${params.name}" deployed.${autoBackup ? " Auto-backup enabled." : ""}`);

  return {
    success: true,
    text: `Cloud agent "${params.name}" deployed`,
    data: {
      op: "provision",
      containerId: id,
      containerUrl: running.load_balancer_url,
      status: running.status,
      creditsDeducted: created.creditsDeducted,
      creditsRemaining: created.creditsRemaining,
      bridgeConnected: bridge?.getConnectionState(id) === "connected",
      autoBackupEnabled: autoBackup,
    },
  };
}

async function handleFreeze(
  runtime: IAgentRuntime,
  message: Memory,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const containers = runtime.getService("CLOUD_CONTAINER") as CloudContainerService;
  const bridge = runtime.getService("CLOUD_BRIDGE") as CloudBridgeService | undefined;
  const backup = runtime.getService("CLOUD_BACKUP") as CloudBackupService | undefined;

  const params = readParams(message, options);
  const containerId = typeof params.containerId === "string" ? params.containerId : null;
  if (!containerId) return { success: false, error: "Missing containerId" };

  const container = await containers.getContainer(containerId);
  if (container.status !== "running") {
    return {
      success: false,
      error: `Container not running (status: ${container.status})`,
    };
  }

  const preview = [
    "Confirmation required before freezing Eliza Cloud agent:",
    `Container: ${container.name}`,
    `ID: ${containerId}`,
    "Effects: create snapshot, disconnect bridge, stop container.",
  ].join("\n");
  if (!isConfirmed(options)) {
    await callback?.({ text: preview, actions: ["CLOUD_AGENT"] });
    return confirmationRequired(preview, {
      op: "freeze",
      containerId,
      containerName: container.name,
    });
  }

  const notify = async (text: string) => {
    if (callback) await callback({ text, actions: ["CLOUD_AGENT"] });
  };
  await notify(`Freezing "${container.name}"... Creating snapshot.`);

  let snapshotId: string | null = null;
  if (backup) {
    const snap = await backup.createSnapshot(containerId, "manual", {
      trigger: "user-freeze",
      containerName: container.name,
    });
    snapshotId = snap.id;
    backup.cancelAutoBackup(containerId);
  }

  if (bridge) await bridge.disconnect(containerId);
  await containers.deleteContainer(containerId);

  await notify(`"${container.name}" frozen.${snapshotId ? ` Snapshot: ${snapshotId}` : ""}`);

  return {
    success: true,
    text: `Agent "${container.name}" frozen`,
    data: { op: "freeze", containerId, containerName: container.name, snapshotId },
  };
}

async function handleResume(
  runtime: IAgentRuntime,
  message: Memory,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const containerSvc = runtime.getService("CLOUD_CONTAINER") as CloudContainerService;
  const bridge = runtime.getService("CLOUD_BRIDGE") as CloudBridgeService | undefined;
  const backup = runtime.getService("CLOUD_BACKUP") as CloudBackupService | undefined;
  const params = readParams(message, options);

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
    await callback?.({ text: preview, actions: ["CLOUD_AGENT"] });
    return confirmationRequired(preview, {
      op: "resume",
      name: String(params.name),
      project_name: String(params.project_name),
      snapshotId: explicitSnapshot,
    });
  }

  const notify = async (text: string) => {
    if (callback) await callback({ text, actions: ["CLOUD_AGENT"] });
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

  let restoredId: string | null = null;
  if (backup) {
    if (explicitSnapshot) {
      await backup.restoreSnapshot(id, explicitSnapshot);
      restoredId = explicitSnapshot;
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
      op: "resume",
      containerId: id,
      containerUrl: running.load_balancer_url,
      restoredSnapshotId: restoredId,
      creditsDeducted: created.creditsDeducted,
      creditsRemaining: created.creditsRemaining,
    },
  };
}

async function handleCheckCredits(
  runtime: IAgentRuntime,
  message: Memory,
  options: HandlerOptions | undefined,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService;
  const containerSvc = runtime.getService("CLOUD_CONTAINER") as CloudContainerService | undefined;
  const client = auth.getClient();

  const params = readParams(message, options);
  const detailed =
    params.detailed === true ||
    (message.metadata as Record<string, unknown> | undefined)?.detailed === true;

  const {
    data: { balance },
  } = await client.get<CreditBalanceResponse>("/credits/balance");

  const running =
    containerSvc?.getTrackedContainers().filter((c) => c.status === "running").length ?? 0;
  const dailyCost = running * DAILY_COST_PER_CONTAINER;
  const daysRemaining = dailyCost > 0 ? balance / dailyCost : null;

  const lines = [
    `ElizaCloud credits: $${balance.toFixed(2)}`,
    running > 0
      ? `Active containers: ${running} ($${dailyCost.toFixed(2)}/day) — ~${daysRemaining?.toFixed(1)} days remaining`
      : "No active containers.",
  ];

  if (detailed) {
    const { data } = await client.get<CreditSummaryResponse>("/credits/summary");
    lines.push(
      `Total spent: $${data.totalSpent.toFixed(2)} | Total added: $${data.totalAdded.toFixed(2)}`
    );
    for (const tx of data.recentTransactions.slice(0, 10)) {
      const sign = tx.amount >= 0 ? "+" : "";
      lines.push(
        `  ${sign}$${tx.amount.toFixed(2)} — ${tx.description} (${new Date(tx.created_at).toLocaleDateString()})`
      );
    }
  }

  const text = lines.join("\n");
  if (callback) await callback({ text, actions: ["CLOUD_AGENT"] });

  return {
    success: true,
    text,
    data: {
      op: "check_credits",
      balance,
      runningContainers: running,
      dailyCost,
      estimatedDaysRemaining: daysRemaining,
    },
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────

export const cloudAgentAction: Action = {
  name: "CLOUD_AGENT",
  contexts: ["cloud", "automation", "admin"],
  contextGate: { anyOf: ["cloud", "automation", "admin"] },
  description:
    "ElizaCloud agent ops router: provision a container, freeze (snapshot+stop) a running agent, resume a frozen agent from snapshot, or check credit balance and runtime estimate.",
  descriptionCompressed: "Cloud agent ops: provision, freeze, resume, check credits.",
  similes: [
    // provision
    "deploy agent to cloud",
    "launch cloud agent",
    "provision container",
    // freeze
    "freeze agent",
    "hibernate agent",
    "stop cloud agent",
    // resume
    "resume agent",
    "unfreeze agent",
    "restore agent",
    // check credits
    "check credits",
    "check balance",
    "cloud billing",
    // legacy action names — keep so older callers still resolve
    "PROVISION_CLOUD_AGENT",
    "FREEZE_CLOUD_AGENT",
    "RESUME_CLOUD_AGENT",
    "CHECK_CLOUD_CREDITS",
  ],
  tags: ["cloud", "container", "deployment", "backup", "billing"],
  parameters: [
    {
      name: "op",
      description:
        "Which cloud-agent operation to run: 'provision', 'freeze', 'resume', or 'check_credits'.",
      required: true,
      schema: {
        type: "string",
        enum: ["provision", "freeze", "resume", "check_credits"],
      },
    },
    {
      name: "name",
      description: "Human-readable agent name. Required for op='provision' and op='resume'.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "project_name",
      description:
        "Project identifier (lowercase, no spaces). Required for op='provision' and op='resume'.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "containerId",
      description: "Container ID. Required for op='freeze'.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "snapshotId",
      description: "Specific snapshot ID for op='resume' (defaults to latest).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "description",
      description: "Optional description for op='provision'.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "environment_vars",
      description: "Additional environment variables for op='provision' or op='resume'.",
      required: false,
      schema: { type: "object" },
    },
    {
      name: "auto_backup",
      description: "Enable periodic auto-backup for op='provision' (default: true).",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "detailed",
      description: "Include transaction history for op='check_credits'.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "confirmed",
      description:
        "Must be true to execute mutating ops ('provision', 'freeze', 'resume') after the preview.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions
  ): Promise<boolean> => {
    const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    return Boolean(auth?.isAuthenticated());
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    const op = readOp(message, options);
    if (!op) {
      return {
        success: false,
        error: `Missing or invalid 'op'. Expected one of: ${VALID_OPS.join(", ")}.`,
      };
    }

    switch (op) {
      case "provision":
        return handleProvision(runtime, message, options, callback);
      case "freeze":
        return handleFreeze(runtime, message, options, callback);
      case "resume":
        return handleResume(runtime, message, options, callback);
      case "check_credits":
        return handleCheckCredits(runtime, message, options, callback);
    }
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: { text: "Deploy a cloud agent named 'support-bot' for project acme-support" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Provisioning cloud agent...",
          actions: ["CLOUD_AGENT"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: { text: "Freeze cloud container c-abc123" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Snapshotting and stopping container...",
          actions: ["CLOUD_AGENT"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: { text: "Resume cloud agent 'support-bot' from latest snapshot" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Re-provisioning and restoring snapshot...",
          actions: ["CLOUD_AGENT"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: { text: "How many cloud credits do I have left?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Checking ElizaCloud credit balance...",
          actions: ["CLOUD_AGENT"],
        },
      },
    ],
  ],
};
