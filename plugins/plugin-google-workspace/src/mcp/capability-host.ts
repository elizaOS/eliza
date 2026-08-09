/**
 * Curated Google Workspace MCP capability materialization for connected
 * accounts. The host owns per-account product attachments and stable elizaOS
 * action names; vendor discovery only enables allowlisted tools whose preview
 * schemas still match the fields the action forwards.
 */

import type { ConnectorAccount } from "@elizaos/core";
import {
  type Action,
  type ActionParameter,
  ElizaError,
  type IAgentRuntime,
  logger,
  normalizeActionName,
} from "@elizaos/core";
import type {
  McpAccessTokenProvider,
  McpAttachmentRef,
  McpDiscovery,
  McpResourceEngine,
} from "@elizaos/plugin-mcp/resource-engine";
import { GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES } from "@elizaos/shared/contracts";

export const GOOGLE_MCP_PRODUCT_ENDPOINTS = {
  gmail: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.endpoint,
  calendar: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.endpoint,
} as const;

export type GoogleMcpProduct = keyof typeof GOOGLE_MCP_PRODUCT_ENDPOINTS;

interface GoogleMcpCapabilityManifest {
  actionName: string;
  description: string;
  product: GoogleMcpProduct;
  toolName: string;
  requiredCapability: string;
  parameters: readonly ActionParameter[];
  schemaProperties: Readonly<Record<string, string>>;
}

const ACCOUNT_PARAMETER: ActionParameter = {
  name: "accountId",
  description: "Connected Google account identifier. Omit to use the default connected account.",
  required: false,
  schema: { type: "string", minLength: 1 },
};

const GOOGLE_MCP_CAPABILITIES: readonly GoogleMcpCapabilityManifest[] = [
  {
    actionName: "GOOGLE_GMAIL_SEARCH_THREADS",
    description:
      "Search Gmail threads in a connected Google account using Gmail query syntax. This is read-only and returns thread summaries, not full message bodies.",
    product: "gmail",
    toolName: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.curatedTools[0],
    requiredCapability: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.gmail.capability,
    schemaProperties: { query: "string" },
    parameters: [
      ACCOUNT_PARAMETER,
      {
        name: "query",
        description: "Gmail search query, for example from:alice@example.com newer_than:7d.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "pageSize",
        description: "Maximum number of matching threads to return (1-50).",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 50 },
      },
      {
        name: "includeTrash",
        description: "Whether Gmail trash should be included.",
        required: false,
        schema: { type: "boolean", default: false },
      },
    ],
  },
  {
    actionName: "GOOGLE_CALENDAR_LIST_EVENTS",
    description:
      "List events from a connected Google Calendar. This is read-only; use time bounds only when the user requested a specific range.",
    product: "calendar",
    toolName: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.curatedTools[0],
    requiredCapability: GOOGLE_WORKSPACE_MCP_CANARY_RESOURCES.calendar.capability,
    schemaProperties: { calendarId: "string", startTime: "string", endTime: "string" },
    parameters: [
      ACCOUNT_PARAMETER,
      {
        name: "calendarId",
        description: "Calendar identifier. Omit for the primary calendar.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "startTime",
        description: "Optional inclusive ISO 8601 lower time bound.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "endTime",
        description: "Optional exclusive ISO 8601 upper time bound.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "pageSize",
        description: "Maximum number of events to return (1-250).",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 250 },
      },
      {
        name: "timeZone",
        description: "IANA time zone used for timezone-less dates.",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "fullText",
        description: "Optional case-insensitive event text filter.",
        required: false,
        schema: { type: "string" },
      },
    ],
  },
] as const;

export interface GoogleMcpProductConnectionReport {
  status: "connected" | "skipped" | "error";
  discoveredTools: string[];
  promotedActions: string[];
  error?: string;
}

export interface GoogleMcpAccountConnectionReport {
  accountId: string;
  products: Partial<Record<GoogleMcpProduct, GoogleMcpProductConnectionReport>>;
}

export interface GoogleMcpCapabilityHostOptions {
  engine: McpResourceEngine;
  accessTokenProviderFor: (
    account: ConnectorAccount,
    product: GoogleMcpProduct
  ) => McpAccessTokenProvider;
  authorizeAccount: (accountId: string, requiredCapability: string) => Promise<boolean>;
}

export interface GoogleMcpCapabilityCall {
  accountId: string;
  product: GoogleMcpProduct;
  result: Awaited<ReturnType<McpResourceEngine["callTool"]>>;
}

interface ActiveGoogleMcpProduct {
  account: ConnectorAccount;
  product: GoogleMcpProduct;
  ref: McpAttachmentRef;
  compatibleActionNames: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolMatchesManifest(
  discovery: McpDiscovery,
  manifest: GoogleMcpCapabilityManifest
): boolean {
  const tool = discovery.tools.find((candidate) => candidate.name === manifest.toolName);
  if (!tool || !isRecord(tool.inputSchema)) return false;
  const properties = tool.inputSchema.properties;
  if (!isRecord(properties)) return false;
  return Object.entries(manifest.schemaProperties).every(([name, expectedType]) => {
    const property = properties[name];
    return isRecord(property) && property.type === expectedType;
  });
}

function selectedProducts(account: ConnectorAccount): GoogleMcpProduct[] {
  const selected = new Set(account.selectedProducts ?? []);
  return (Object.keys(GOOGLE_MCP_PRODUCT_ENDPOINTS) as GoogleMcpProduct[]).filter((product) =>
    selected.has(product)
  );
}

function accountSupports(account: ConnectorAccount, capability: string): boolean {
  return account.status === "connected" && (account.capabilities ?? []).includes(capability);
}

function parametersFromOptions(options: unknown): Record<string, unknown> {
  if (!isRecord(options) || !isRecord(options.parameters)) return {};
  return options.parameters;
}

function toolArguments(
  manifest: GoogleMcpCapabilityManifest,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {};
  for (const parameter of manifest.parameters) {
    if (parameter.name === "accountId") continue;
    const value = parameters[parameter.name];
    if (value !== undefined) forwarded[parameter.name] = value;
  }
  return forwarded;
}

function resultText(result: Awaited<ReturnType<McpResourceEngine["callTool"]>>): string {
  const text = result.content
    .filter(
      (content): content is Extract<(typeof result.content)[number], { type: "text" }> =>
        content.type === "text"
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (text) return text;
  return result.structuredContent
    ? JSON.stringify(result.structuredContent)
    : "Google MCP returned no text.";
}

export class GoogleMcpCapabilityHost {
  private readonly active = new Map<string, ActiveGoogleMcpProduct>();
  private readonly ownedActions = new Map<string, Action>();

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly options: GoogleMcpCapabilityHostOptions
  ) {}

  async connectAccount(account: ConnectorAccount): Promise<GoogleMcpAccountConnectionReport> {
    await this.disconnectAccount(account.id);
    const report: GoogleMcpAccountConnectionReport = { accountId: account.id, products: {} };
    for (const product of selectedProducts(account)) {
      const manifests = GOOGLE_MCP_CAPABILITIES.filter(
        (manifest) =>
          manifest.product === product && accountSupports(account, manifest.requiredCapability)
      );
      if (manifests.length === 0) {
        report.products[product] = {
          status: "skipped",
          discoveredTools: [],
          promotedActions: [],
        };
        continue;
      }
      let ref: McpAttachmentRef | undefined;
      try {
        ref = await this.options.engine.attach({
          key: `google:${String(this.runtime.agentId)}:${account.id}:${product}`,
          endpoint: GOOGLE_MCP_PRODUCT_ENDPOINTS[product],
          auth: this.options.accessTokenProviderFor(account, product),
        });
        const discovery = await this.options.engine.discover(ref);
        const compatible = manifests.filter((manifest) => toolMatchesManifest(discovery, manifest));
        this.active.set(this.activeKey(account.id, product), {
          account: {
            ...account,
            purpose: [...account.purpose],
            capabilities: account.capabilities ? [...account.capabilities] : undefined,
          },
          product,
          ref,
          compatibleActionNames: new Set(compatible.map((manifest) => manifest.actionName)),
        });
        report.products[product] = {
          status: "connected",
          discoveredTools: discovery.tools.map((tool) => tool.name),
          promotedActions: compatible.map((manifest) => manifest.actionName),
        };
      } catch (error) {
        // error-policy:J4 Product resources degrade independently; the report
        // exposes the failed product while successful siblings remain usable.
        if (ref) await this.detachBestEffort(ref, account.id, product);
        const message = error instanceof Error ? error.message : String(error);
        report.products[product] = {
          status: "error",
          discoveredTools: [],
          promotedActions: [],
          error: message,
        };
        this.runtime.reportError?.("google-mcp-connect", error, {
          accountId: account.id,
          product,
        });
      }
    }
    this.reconcileActions();
    return report;
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const detached: ActiveGoogleMcpProduct[] = [];
    for (const [key, active] of this.active) {
      if (active.account.id !== accountId) continue;
      this.active.delete(key);
      detached.push(active);
    }
    this.reconcileActions();
    await Promise.all(
      detached.map((active) => this.detachBestEffort(active.ref, active.account.id, active.product))
    );
  }

  async stop(): Promise<void> {
    const accountIds = new Set([...this.active.values()].map((active) => active.account.id));
    for (const accountId of accountIds) await this.disconnectAccount(accountId);
  }

  async callCapability(
    actionName: string,
    accountId: string,
    arguments_: Readonly<Record<string, unknown>>
  ): Promise<GoogleMcpCapabilityCall | null> {
    const normalizedName = normalizeActionName(actionName);
    const manifest = GOOGLE_MCP_CAPABILITIES.find(
      (candidate) => normalizeActionName(candidate.actionName) === normalizedName
    );
    if (!manifest) return null;
    const active = this.selectResource(manifest, accountId);
    if (!active) return null;
    if (!(await this.options.authorizeAccount(active.account.id, manifest.requiredCapability))) {
      throw new ElizaError(`Google account ${active.account.id} is no longer authorized`, {
        code: "GOOGLE_MCP_ACCOUNT_NOT_AUTHORIZED",
        context: {
          accountId: active.account.id,
          capability: manifest.requiredCapability,
        },
      });
    }
    return {
      accountId: active.account.id,
      product: active.product,
      result: await this.options.engine.callTool(active.ref, {
        name: manifest.toolName,
        arguments: { ...arguments_ },
      }),
    };
  }

  private activeKey(accountId: string, product: GoogleMcpProduct): string {
    return `${accountId}:${product}`;
  }

  private compatibleResources(manifest: GoogleMcpCapabilityManifest): ActiveGoogleMcpProduct[] {
    return [...this.active.values()]
      .filter(
        (active) =>
          active.product === manifest.product &&
          active.compatibleActionNames.has(manifest.actionName) &&
          accountSupports(active.account, manifest.requiredCapability)
      )
      .sort(
        (left, right) =>
          Number(Boolean(right.account.isDefault)) - Number(Boolean(left.account.isDefault)) ||
          left.account.id.localeCompare(right.account.id)
      );
  }

  private reconcileActions(): void {
    const desired = new Map(
      GOOGLE_MCP_CAPABILITIES.filter(
        (manifest) => this.compatibleResources(manifest).length > 0
      ).map((manifest) => [normalizeActionName(manifest.actionName), manifest] as const)
    );
    for (const [normalizedName, action] of this.ownedActions) {
      if (desired.has(normalizedName)) continue;
      if (this.runtime.actions.find((candidate) => candidate === action)) {
        this.runtime.unregisterAction(action.name);
      }
      this.ownedActions.delete(normalizedName);
    }
    for (const [normalizedName, manifest] of desired) {
      if (this.ownedActions.has(normalizedName)) continue;
      const incumbent = this.runtime.actions.find(
        (action) => normalizeActionName(action.name) === normalizedName
      );
      if (incumbent) {
        logger.warn(
          { src: "plugin:google:mcp", actionName: manifest.actionName },
          `[GoogleMcpCapabilityHost] action name collision for ${manifest.actionName}; keeping incumbent`
        );
        continue;
      }
      const action = this.buildAction(manifest);
      this.runtime.registerAction(action);
      if (
        this.runtime.actions.find(
          (candidate) => normalizeActionName(candidate.name) === normalizedName
        ) === action
      ) {
        this.ownedActions.set(normalizedName, action);
      }
    }
  }

  private buildAction(manifest: GoogleMcpCapabilityManifest): Action {
    return {
      name: manifest.actionName,
      description: manifest.description,
      contexts: ["connectors", "automation"],
      parameters: manifest.parameters.map((parameter) => ({
        ...parameter,
        schema: { ...parameter.schema },
      })),
      connectorAccountPolicy: {
        provider: "google",
        statuses: ["connected"],
        roles: ["OWNER", "AGENT", "TEAM"],
        accessGates: ["open", "owner_binding"],
        requiredCapabilities: [manifest.requiredCapability],
      },
      validate: async (_runtime, _message, _state, options) => {
        const parameters = parametersFromOptions(options);
        return Boolean(this.selectResource(manifest, parameters.accountId));
      },
      handler: async (_runtime, _message, _state, options) => {
        const parameters = parametersFromOptions(options);
        const active = this.selectResource(manifest, parameters.accountId);
        if (!active) {
          return {
            success: false,
            error: new ElizaError(
              `No live Google MCP resource can execute ${manifest.actionName}`,
              {
                code: "GOOGLE_MCP_CAPABILITY_UNAVAILABLE",
                context: { actionName: manifest.actionName },
              }
            ),
          };
        }
        try {
          const execution = await this.callCapability(
            manifest.actionName,
            active.account.id,
            toolArguments(manifest, parameters)
          );
          if (!execution) {
            throw new ElizaError(`Google MCP capability ${manifest.actionName} disconnected`, {
              code: "GOOGLE_MCP_CAPABILITY_UNAVAILABLE",
              context: { actionName: manifest.actionName, accountId: active.account.id },
            });
          }
          const { result } = execution;
          return {
            success: result.isError !== true,
            text: resultText(result),
            transcriptVisibility: "internal",
            data: { accountId: execution.accountId, product: execution.product, result },
            ...(result.isError ? { error: resultText(result) } : {}),
          };
        } catch (error) {
          // error-policy:J1 The action is the planner boundary for an exact
          // external tool failure; preserve the error without claiming success.
          return {
            success: false,
            error: error instanceof Error ? error : String(error),
          };
        }
      },
    };
  }

  private selectResource(
    manifest: GoogleMcpCapabilityManifest,
    requestedAccountId: unknown
  ): ActiveGoogleMcpProduct | undefined {
    const candidates = this.compatibleResources(manifest);
    if (typeof requestedAccountId !== "string" || !requestedAccountId.trim()) {
      return candidates[0];
    }
    return candidates.find((candidate) => candidate.account.id === requestedAccountId.trim());
  }

  private async detachBestEffort(
    ref: McpAttachmentRef,
    accountId: string,
    product: GoogleMcpProduct
  ): Promise<void> {
    try {
      await this.options.engine.detach(ref);
    } catch (error) {
      // error-policy:J6 Disconnect teardown is best effort after local action
      // exposure has already been revoked.
      logger.warn(
        { error, accountId, product },
        `[GoogleMcpCapabilityHost] failed to detach ${product} resource`
      );
    }
  }
}
