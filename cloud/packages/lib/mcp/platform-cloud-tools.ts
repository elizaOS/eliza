import type { Context } from "hono";
import { organizationsRepository } from "@/db/repositories";
import { requireAdmin, requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  executeCloudCapabilityRest,
  getCloudCapabilities,
  getCloudProtocolCoverage,
} from "@/lib/cloud-capabilities";
import { activeBillingService } from "@/lib/services/active-billing";
import { containersService } from "@/lib/services/containers";
import { creditsService } from "@/lib/services/credits";
import type { AppEnv } from "@/types/cloud-worker-env";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ToolArgs = Record<string, unknown>;
type AppContext = Context<AppEnv>;

const jsonSchemaObject = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const protocolTools: McpToolDefinition[] = [
  {
    name: "cloud.capabilities.list",
    description: "List Eliza Cloud capabilities and REST/MCP/A2A/skill coverage.",
    inputSchema: jsonSchemaObject({
      category: {
        type: "string",
        description: "Optional capability category filter.",
      },
      includeDetails: {
        type: "boolean",
        description: "Return full capability definitions instead of compact coverage rows.",
      },
    }),
  },
  {
    name: "cloud.api.request",
    description:
      "Call any authenticated Eliza Cloud REST API route by path. Use for capabilities not represented by a narrower MCP tool.",
    inputSchema: jsonSchemaObject(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "A path beginning with /api/." },
        query: { type: "object", additionalProperties: true },
        body: { type: "object", additionalProperties: true },
      },
      ["method", "path"],
    ),
  },
  {
    name: "cloud.admin.request",
    description:
      "Admin-only generic request tool for /api/admin and /api/v1/admin routes. Requires an admin wallet/API identity.",
    inputSchema: jsonSchemaObject(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: {
          type: "string",
          description: "An admin API path beginning with /api/admin or /api/v1/admin.",
        },
        query: { type: "object", additionalProperties: true },
        body: { type: "object", additionalProperties: true },
      },
      ["method", "path"],
    ),
  },
];

function capabilityToolDefinitions(): McpToolDefinition[] {
  return getCloudCapabilities().map((capability) => ({
    name: capability.surfaces.mcp.tool,
    description: `${capability.summary} REST: ${capability.surfaces.rest.method} ${capability.surfaces.rest.path}`,
    inputSchema: jsonSchemaObject({
      action: {
        type: "string",
        description: "Optional action or subcommand for compatible capability routes.",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        description: "Optional REST method override when this capability supports multiple verbs.",
      },
      pathParams: { type: "object", additionalProperties: true },
      query: { type: "object", additionalProperties: true },
      body: { type: "object", additionalProperties: true },
      headers: {
        type: "object",
        additionalProperties: true,
        description: "Optional safe forwarded headers, such as x-payment for x402 settlement.",
      },
      params: {
        type: "object",
        additionalProperties: true,
        description:
          "Capability-specific parameters. Path params can be supplied here by name, e.g. id or amount.",
      },
    }),
  }));
}

export function listPlatformCloudMcpTools(): McpToolDefinition[] {
  const tools = [...protocolTools, ...capabilityToolDefinitions()];
  const deduped = new Map(tools.map((tool) => [tool.name, tool]));
  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function asObject(value: unknown): ToolArgs {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ToolArgs) : {};
}

function jsonText(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function copyAuthHeaders(c: AppContext): Headers {
  const headers = new Headers();
  for (const name of [
    "authorization",
    "x-api-key",
    "x-wallet-address",
    "x-timestamp",
    "x-wallet-signature",
    "x-payment",
    "idempotency-key",
    "x-idempotency-key",
    "cookie",
  ]) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  return headers;
}

function buildInternalUrl(c: AppContext, path: string, query?: unknown): URL {
  if (!path.startsWith("/api/")) {
    throw new Error("path must begin with /api/");
  }
  if (path.startsWith("/api/mcp")) {
    throw new Error("cloud.api.request cannot recursively call /api/mcp");
  }

  const url = new URL(path, c.req.url);
  const queryObject = asObject(query);
  for (const [key, value] of Object.entries(queryObject)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function callInternalApi(c: AppContext, args: ToolArgs, adminOnly = false) {
  const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
  const path = typeof args.path === "string" ? args.path : "";
  if (adminOnly && !path.startsWith("/api/admin") && !path.startsWith("/api/v1/admin")) {
    throw new Error("cloud.admin.request only allows /api/admin and /api/v1/admin paths");
  }

  const url = buildInternalUrl(c, path, args.query);
  const response = await fetch(url, {
    method,
    headers: copyAuthHeaders(c),
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(args.body ?? {}),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  return {
    status: response.status,
    ok: response.ok,
    body,
  };
}

export async function callPlatformCloudMcpTool(c: AppContext, name: string, args: unknown) {
  const input = asObject(args);

  switch (name) {
    case "cloud.capabilities.list": {
      const category = typeof input.category === "string" ? input.category : undefined;
      const includeDetails = input.includeDetails === true;
      const capabilities = includeDetails ? getCloudCapabilities() : getCloudProtocolCoverage();
      return jsonText({
        capabilities: category
          ? capabilities.filter((capability) => capability.category === category)
          : capabilities,
      });
    }
    case "cloud.api.request": {
      await requireUserOrApiKeyWithOrg(c);
      return jsonText(await callInternalApi(c, input));
    }
    case "cloud.admin.request": {
      await requireAdmin(c);
      return jsonText(await callInternalApi(c, input, true));
    }
    case "cloud.account.profile": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return jsonText({
        user: {
          id: user.id,
          email: user.email,
          walletAddress: user.wallet_address,
          organizationId: user.organization_id,
          role: user.role,
        },
        organization: user.organization,
      });
    }
    case "cloud.credits.summary": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const org = await organizationsRepository.findById(user.organization_id);
      const transactions = await creditsService.listTransactionsByOrganization(
        user.organization_id,
        10,
      );
      return jsonText({
        organizationId: user.organization_id,
        balance: Number(org?.credit_balance ?? 0),
        recentTransactions: transactions,
      });
    }
    case "cloud.credits.transactions": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const limit = typeof input.limit === "number" ? input.limit : 50;
      return jsonText({
        transactions: await creditsService.listTransactionsByOrganization(
          user.organization_id,
          limit,
        ),
      });
    }
    case "cloud.billing.active_resources": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return jsonText({
        resources: await activeBillingService.listActiveResources(user.organization_id),
      });
    }
    case "cloud.billing.ledger": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const limit = typeof input.limit === "number" ? input.limit : 50;
      return jsonText({
        ledger: await activeBillingService.listLedger(user.organization_id, limit),
      });
    }
    case "cloud.billing.cancel_resource": {
      const user = await requireUserOrApiKeyWithOrg(c);
      const resourceId = typeof input.resourceId === "string" ? input.resourceId : "";
      if (!resourceId) throw new Error("resourceId is required");
      const resourceType =
        input.resourceType === "container" || input.resourceType === "agent_sandbox"
          ? input.resourceType
          : undefined;
      return jsonText(
        await activeBillingService.cancelResource({
          organizationId: user.organization_id,
          resourceId,
          resourceType,
          mode: input.mode === "delete" ? "delete" : "stop",
        }),
      );
    }
    case "cloud.containers.manage": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return jsonText({
        containers: await containersService.listByOrganization(user.organization_id),
      });
    }
    case "cloud.containers.quota": {
      const user = await requireUserOrApiKeyWithOrg(c);
      return jsonText({
        quota: await containersService.checkQuota(user.organization_id),
      });
    }
    case "cloud.mcp.platform": {
      return jsonText({
        tools: listPlatformCloudMcpTools(),
      });
    }
    default:
      return jsonText(await executeCloudCapabilityRest(c, name, input));
  }
}
