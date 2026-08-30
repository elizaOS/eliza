/**
 * Cloud API platform agent helpers shared across A2A worker routes.
 *
 * The dispatcher translates platform skills into the same service and
 * repository calls used by REST surfaces, then wraps successful results as A2A
 * tasks. Failures are allowed to reach the JSON-RPC boundary so broken billing
 * or account reads become observable errors instead of fabricated task data.
 */
import { organizationsRepository } from "../../../db/repositories";
import { parseOrganizationCreditBalance } from "../../../db/repositories/organizations-credit-balance-numeric";
import type { AppContext } from "../../../types/cloud-worker-env";
import {
  requireAdmin,
  requireCurrentBillingManagerSession,
  requireUserOrApiKeyWithOrg,
} from "../../auth/workers-hono-auth";
import { executeCloudCapabilityRest, getCloudCapabilities } from "../../cloud-capabilities";
import { a2aTaskStoreService } from "../../services/a2a-task-store";
import { activeBillingService } from "../../services/active-billing";
import { containersService } from "../../services/containers";
import { creditsService } from "../../services/credits";
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
} from "../../types/a2a";
import { logger } from "../../utils/logger";
import { safeUnknownErrorMessage } from "../cloud-worker-errors";
import {
  A2AJsonRpcRequestSchema,
  jsonRpcIdFromUnknown,
  UntrustedA2AMessageSendParamsSchema,
} from "./request-validation";

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
      organizationRoles: capability.auth.organizationRoles ?? [],
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
          organizationRoles: capability.auth.organizationRoles ?? [],
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
      if (!org) {
        throw new Error(`Organization not found for credits summary: ${user.organization_id}`);
      }
      return {
        organizationId: user.organization_id,
        balance: parseOrganizationCreditBalance(org.credit_balance, "credit_balance"),
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
      const resourceId = typeof args.resourceId === "string" ? args.resourceId : "";
      if (!resourceId) throw new Error("resourceId is required");
      const resourceType =
        args.resourceType === "container" || args.resourceType === "agent_sandbox"
          ? args.resourceType
          : undefined;
      if (!resourceType) throw new Error("resourceType is required");
      if (args.mode !== undefined && args.mode !== "stop") {
        throw new Error("Only mode=stop supports durable billing cancellation");
      }
      if (
        !Number.isSafeInteger(args.expectedLifecycleRevision) ||
        Number(args.expectedLifecycleRevision) < 0
      ) {
        throw new Error("expectedLifecycleRevision is required");
      }
      const idempotencyKey =
        typeof args.idempotencyKey === "string"
          ? args.idempotencyKey
          : (c.req.header("idempotency-key") ?? "");
      const user = await requireCurrentBillingManagerSession(c);
      return activeBillingService.requestCancellation({
        organizationId: user.organization_id,
        requestedByUserId: user.id,
        resourceId,
        resourceType,
        expectedLifecycleRevision: Number(args.expectedLifecycleRevision),
        idempotencyKey,
        triggerEnv: c.env,
        authorizeInfrastructureMutation: async () => {
          const current = await requireCurrentBillingManagerSession(c);
          return current.steward_id;
        },
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

export async function handlePlatformMessageSend(c: AppContext, params: unknown) {
  const validated = UntrustedA2AMessageSendParamsSchema.parse(params);
  const { message } = validated;
  const paramsMetadata = validated.metadata ?? {};
  const data = { ...extractData(message), ...paramsMetadata };
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

export async function handlePlatformA2aJsonRpc(c: AppContext, input: unknown) {
  const validation = A2AJsonRpcRequestSchema.safeParse(input);
  if (!validation.success) {
    return jsonRpcError(-32600, "Invalid Request", jsonRpcIdFromUnknown(input));
  }
  const request = validation.data;
  const id = request.id;
  try {
    switch (request.method) {
      case "message/send": {
        const params = UntrustedA2AMessageSendParamsSchema.safeParse(request.params);
        if (!params.success) return jsonRpcError(-32602, "Invalid params", id);
        return jsonRpcSuccess(await handlePlatformMessageSend(c, params.data), id);
      }
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
    // Redact infra/DB/5xx faults (raw SQL/SQLSTATE/driver internals); deliberate
    // 4xx errors keep their message. Full error logged server-side.
    logger.error("[A2A Platform] JSON-RPC dispatch failed", {
      method: request.method,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcError(-32000, safeUnknownErrorMessage(error), id);
  }
}
