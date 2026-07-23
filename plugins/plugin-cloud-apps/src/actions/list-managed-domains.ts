/**
 * Lists the authenticated organization's complete Eliza Cloud domain inventory.
 *
 * This account-level view includes assignments beyond published projects, so
 * it complements rather than replaces the project-scoped domain list action.
 */

import type { ManagedDomainDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { getCloudClient, resolveCloudApiKey } from "../client.js";

const ACTION = "LIST_MANAGED_DOMAINS";
const NO_KEY_MESSAGE =
  "Connect Eliza Cloud before listing your managed domains.";
const ERROR_MESSAGE =
  "I couldn't load your Eliza Cloud domain inventory right now. Try again in a moment.";
const REGISTRARS = new Set(["external", "cloudflare"]);
const STATUSES = new Set([
  "pending",
  "active",
  "expired",
  "suspended",
  "transferring",
]);
const SSL_STATUSES = new Set(["pending", "provisioning", "active", "error"]);
const RESOURCE_TYPES = new Set(["app", "container", "agent", "mcp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function assignmentId(domain: ManagedDomainDto): string | null {
  if (domain.resourceType === "app") return domain.appId;
  if (domain.resourceType === "container") return domain.containerId;
  if (domain.resourceType === "agent") return domain.agentId;
  if (domain.resourceType === "mcp") return domain.mcpId;
  return null;
}

function hasValidAssignment(value: Record<string, unknown>): boolean {
  const assignmentKeys = {
    app: "appId",
    container: "containerId",
    agent: "agentId",
    mcp: "mcpId",
  } as const;
  if (value.resourceType === null) {
    return Object.values(assignmentKeys).every((key) => value[key] === null);
  }
  if (
    typeof value.resourceType !== "string" ||
    !RESOURCE_TYPES.has(value.resourceType)
  ) {
    return false;
  }
  return Object.entries(assignmentKeys).every(([resourceType, key]) =>
    resourceType === value.resourceType
      ? typeof value[key] === "string" && value[key].length > 0
      : value[key] === null,
  );
}

function isManagedDomain(value: unknown): value is ManagedDomainDto {
  if (!isRecord(value)) return false;
  const resourceTypeValid =
    value.resourceType === null ||
    (typeof value.resourceType === "string" &&
      RESOURCE_TYPES.has(value.resourceType));
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.domain === "string" &&
    value.domain.length > 0 &&
    value.domain.length <= 253 &&
    typeof value.registrar === "string" &&
    REGISTRARS.has(value.registrar) &&
    typeof value.status === "string" &&
    STATUSES.has(value.status) &&
    typeof value.verified === "boolean" &&
    (value.sslStatus === null ||
      (typeof value.sslStatus === "string" &&
        SSL_STATUSES.has(value.sslStatus))) &&
    optionalString(value.expiresAt) &&
    typeof value.autoRenew === "boolean" &&
    resourceTypeValid &&
    optionalString(value.appId) &&
    optionalString(value.containerId) &&
    optionalString(value.agentId) &&
    optionalString(value.mcpId) &&
    optionalString(value.cloudflareZoneId) &&
    hasValidAssignment(value)
  );
}

function assertManagedDomainsResponse(response: unknown): ManagedDomainDto[] {
  if (
    !isRecord(response) ||
    response.success !== true ||
    !Array.isArray(response.domains) ||
    !response.domains.every(isManagedDomain)
  ) {
    throw new ElizaError("Cloud returned an invalid managed-domain inventory", {
      code: "CLOUD_MANAGED_DOMAINS_INVALID",
      severity: "fatal",
    });
  }
  return response.domains;
}

function assignmentLabel(domain: ManagedDomainDto): string {
  if (domain.resourceType === "app") return "assigned to a published project";
  if (domain.resourceType === "container") return "assigned to a container";
  if (domain.resourceType === "agent") return "assigned to an agent";
  if (domain.resourceType === "mcp") return "assigned to an MCP server";
  return "not assigned";
}

function domainLine(domain: ManagedDomainDto): string {
  const registrar =
    domain.registrar === "cloudflare"
      ? "registered through Eliza Cloud"
      : "externally registered";
  const ssl = `SSL ${domain.sslStatus ?? "unavailable"}`;
  const expiry = domain.expiresAt
    ? `${domain.autoRenew ? "auto-renews" : "expires"} ${domain.expiresAt.slice(0, 10)}`
    : domain.autoRenew
      ? "auto-renew enabled"
      : "renewal date unavailable";
  return `• ${domain.domain} — ${registrar}, ${domain.status}, ${ssl}, ${expiry}, ${assignmentLabel(domain)}`;
}

export const listManagedDomainsAction: Action = {
  name: ACTION,
  similes: ["LIST_ACCOUNT_DOMAINS", "SHOW_MANAGED_DOMAINS", "DOMAIN_INVENTORY"],
  description:
    "List every domain the authenticated Eliza Cloud organization owns or manages, including status, SSL, renewal, and assignment. Read-only. Use for an account-wide domain inventory; use LIST_APP_DOMAINS for one published project.",
  descriptionCompressed: "List the account-wide Eliza Cloud domain inventory.",
  contexts: ["settings", "finance", "projects"],
  contextGate: { anyOf: ["settings", "finance", "projects"] },
  suppressPostActionContinuation: true,
  parameters: [],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: unknown,
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

    try {
      const domains = assertManagedDomainsResponse(
        await client.listManagedDomains(),
      );
      if (domains.length === 0) {
        const reply = "You don't have any domains managed by Eliza Cloud yet.";
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: "No managed domains found.",
          userFacingText: reply,
          verifiedUserFacing: true,
          data: { domains: [] },
        };
      }

      const reply = [
        `Your Eliza Cloud account has ${domains.length} managed domain${domains.length === 1 ? "" : "s"}:`,
        ...domains.map(domainLine),
      ].join("\n");
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Listed ${domains.length} managed domain(s).`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          domains: domains.map((domain) => ({
            id: domain.id,
            domain: domain.domain,
            registrar: domain.registrar,
            status: domain.status,
            verified: domain.verified,
            sslStatus: domain.sslStatus,
            expiresAt: domain.expiresAt,
            autoRenew: domain.autoRenew,
            assignment:
              domain.resourceType === null
                ? null
                : {
                    type: domain.resourceType,
                    id: assignmentId(domain),
                  },
          })),
        },
      };
    } catch (error) {
      // error-policy:J1 action boundary returns an observable planner failure.
      logger.error(
        { error },
        "[LIST_MANAGED_DOMAINS] Domain inventory read failed",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "Managed-domain inventory read failed.",
        userFacingText: ERROR_MESSAGE,
        error: error instanceof Error ? error : new Error(String(error)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "show every domain in my Cloud account" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Your Eliza Cloud account has 1 managed domain:\n• habit.tools — registered through Eliza Cloud, active, SSL active, auto-renews 2027-07-23, assigned to a published project",
          actions: [ACTION],
        },
      },
    ],
  ],
};

export default listManagedDomainsAction;
