import { organizationsRepository } from "@/db/repositories";
import { requireAdmin, requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { executeCloudCapabilityRest, getCloudCapabilities } from "@/lib/cloud-capabilities";
import { a2aTaskStoreService } from "@/lib/services/a2a-task-store";
import { activeBillingService } from "@/lib/services/active-billing";
import { containersService } from "@/lib/services/containers";
import { creditsService } from "@/lib/services/credits";
import {
  createArtifact,
  createDataPart,
  createMessage,
  createTask,
  createTaskStatus,
  createTextPart,
  jsonRpcError,
  jsonRpcSuccess,
  type Message,
  type Task,
  type TaskState,
} from "@/lib/types/a2a";
import type { AppContext } from "@/types/cloud-worker-env";

type JsonRpcId = string | number | null;

function getBaseUrl(c: AppContext): string {
  return c.env.NEXT_PUBLIC_APP_URL || new URL(c.req.url).origin;
}

export function getPlatformAgentCard(c: AppContext) {
  const baseUrl = getBaseUrl(c);
  return {
    name: "Eliza Cloud",
    description:
      "Cloud platform agent for account, credits, billing, apps, agents, MCPs, containers, and admin operations.",
    url: `${baseUrl}/api/a2a`,
    provider: {
      organization: "Eliza Cloud",
      url: baseUrl,
    },
    version: "1.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: [
        { scheme: "bearer", description: "Eliza API key or Steward bearer token" },
        { scheme: "wallet_signature", description: "X-Wallet-* per-request signature headers" },
      ],
    },
    skills: getCloudCapabilities().map((capability) => ({
      id: capability.surfaces.a2a.skill,
      name: capability.title,
      description: capability.summary,
      tags: [capability.category, ...(capability.auth.adminOnly ? ["admin"] : [])],
      inputModes: ["application/json", "text/plain"],
      outputModes: ["application/json"],
      rest: capability.surfaces.rest,
      authModes: capability.auth.modes,
      billing: capability.billing,
    })),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractData(message?: Message): Record<string, unknown> {
  const dataPart = message?.parts?.find((part) => part.type === "data");
  return dataPart?.type === "data" ? asObject(dataPart.data) : {};
}

function extractText(message?: Message): string {
  return (
    message?.parts
      ?.filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim() ?? ""
  );
}

async function storePlatformTask(task: Task, user: { id: string; organization_id: string }) {
  await a2aTaskStoreService.set(task.id, {
    task,
    userId: user.id,
    organizationId: user.organization_id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function executePlatformSkill(c: AppContext, skill: string, args: Record<string, unknown>) {
  switch (skill) {
    case "cloud.capabilities.list":
    case "cloud.a2a.platform": {
      return { capabilities: getCloudCapabilities() };
    }
    case "cloud.mcp.platform": {
      return {
        endpoint: `${getBaseUrl(c)}/api/mcp`,
        tools: getCloudCapabilities().map((capability) => ({
          capabilityId: capability.id,
          tool: capability.surfaces.mcp.tool,
          rest: capability.surfaces.rest,
          authModes: capability.auth.modes,
          billing: capability.billing,
        })),
      };
    }
    case "cloud.account.profile": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return {
        user: {
          id: user.id,
          email: user.email,
          walletAddress: user.wallet_address,
          organizationId: user.organization_id,
          role: user.role,
        },
        organization: user.organization,
      };
    }
    case "cloud.credits.summary": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const [org, transactions] = await Promise.all([
        organizationsRepository.findById(user.organization_id),
        creditsService.listTransactionsByOrganization(user.organization_id, 10),
      ]);
      return {
        organizationId: user.organization_id,
        balance: Number(org?.credit_balance ?? 0),
        recentTransactions: transactions,
      };
    }
    case "cloud.credits.transactions": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return {
        transactions: await creditsService.listTransactionsByOrganization(
          user.organization_id,
          limit,
        ),
      };
    }
    case "cloud.billing.active_resources": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return {
        resources: await activeBillingService.listActiveResources(user.organization_id),
      };
    }
    case "cloud.billing.ledger": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return { ledger: await activeBillingService.listLedger(user.organization_id, limit) };
    }
    case "cloud.billing.cancel_resource": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const resourceId = typeof args.resourceId === "string" ? args.resourceId : "";
      if (!resourceId) throw new Error("resourceId is required");
      return activeBillingService.cancelResource({
        organizationId: user.organization_id,
        resourceId,
        resourceType:
          args.resourceType === "container" || args.resourceType === "agent_sandbox"
            ? args.resourceType
            : undefined,
        mode: args.mode === "delete" ? "delete" : "stop",
      });
    }
    case "cloud.containers.manage": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return { containers: await containersService.listByOrganization(user.organization_id) };
    }
    case "cloud.containers.quota": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return { quota: await containersService.checkQuota(user.organization_id) };
    }
    default: {
      if (skill.startsWith("cloud.admin.")) {
        await requireAdmin(c);
      }
      const capability = getCloudCapabilities().find((item) => item.surfaces.a2a.skill === skill);
      if (!capability) throw new Error(`Unknown Cloud A2A skill: ${skill}`);
      return executeCloudCapabilityRest(c, skill, args);
    }
  }
}

export async function handlePlatformMessageSend(c: AppContext, params: Record<string, unknown>) {
  const message = params.message as Message | undefined;
  const data = { ...extractData(message), ...asObject(params.metadata) };
  const skill =
    typeof data.skill === "string"
      ? data.skill
      : typeof data.capability === "string"
        ? data.capability
        : "cloud.capabilities.list";
  const text = extractText(message);
  const args = { ...asObject(data.params), text };
  const capability = getCloudCapabilities().find((item) => item.surfaces.a2a.skill === skill);
  const user = capability?.category === "auth" ? null : await requireUserOrApiKeyWithOrg(c);
  const result = await executePlatformSkill(c, skill, args);
  const taskId = typeof data.taskId === "string" ? data.taskId : crypto.randomUUID();
  const task = createTask(
    taskId,
    "completed",
    createMessage("agent", [
      createTextPart(`Completed ${skill}`),
      createDataPart(result as object),
    ]),
    typeof data.contextId === "string" ? data.contextId : undefined,
    { skill },
  );
  task.history = message
    ? ([message, task.status.message].filter(Boolean) as Message[])
    : [task.status.message!];
  task.artifacts = [
    createArtifact([createDataPart(result as object)], skill, `Result for ${skill}`, 0, {
      skill,
    }),
  ];
  if (user) await storePlatformTask(task, user);
  return task;
}

export async function handlePlatformTasksGet(c: AppContext, params: Record<string, unknown>) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const id = typeof params.id === "string" ? params.id : "";
  const entry = await a2aTaskStoreService.get(id, user.organization_id);
  if (!entry) {
    throw new Error(`Task not found: ${id}`);
  }
  const task = { ...entry.task };
  const historyLength = typeof params.historyLength === "number" ? params.historyLength : undefined;
  if (historyLength !== undefined && task.history) {
    task.history = task.history.slice(-historyLength);
  }
  return task;
}

export async function handlePlatformTasksCancel(c: AppContext, params: Record<string, unknown>) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const id = typeof params.id === "string" ? params.id : "";
  const entry = await a2aTaskStoreService.get(id, user.organization_id);
  if (!entry) {
    throw new Error(`Task not found: ${id}`);
  }
  const terminalStates: TaskState[] = ["completed", "canceled", "failed", "rejected"];
  if (terminalStates.includes(entry.task.status.state)) {
    throw new Error(`Task ${id} is already in terminal state: ${entry.task.status.state}`);
  }

  const canceled = await a2aTaskStoreService.updateTaskState(
    id,
    user.organization_id,
    "canceled",
    createMessage("agent", [createTextPart("Task canceled")]),
  );
  if (!canceled) throw new Error(`Failed to update task: ${id}`);
  canceled.status = createTaskStatus("canceled", canceled.status.message);
  return canceled;
}

export async function handlePlatformA2aJsonRpc(
  c: AppContext,
  request: { id?: JsonRpcId; method?: string; params?: Record<string, unknown> },
) {
  const id = request.id ?? null;
  try {
    switch (request.method) {
      case "message/send":
        return jsonRpcSuccess(await handlePlatformMessageSend(c, request.params ?? {}), id);
      case "tasks/get":
        return jsonRpcSuccess(await handlePlatformTasksGet(c, request.params ?? {}), id);
      case "tasks/cancel":
        return jsonRpcSuccess(await handlePlatformTasksCancel(c, request.params ?? {}), id);
      case "agent/getAuthenticatedExtendedCard":
        await requireUserOrApiKeyWithOrg(c);
        return jsonRpcSuccess(getPlatformAgentCard(c), id);
      default:
        return jsonRpcError(-32601, `Unsupported A2A method: ${request.method}`, id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonRpcError(-32000, message, id);
  }
}
