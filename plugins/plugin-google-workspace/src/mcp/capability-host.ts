/**
 * Materializes curated, account-bound actions from official Google Workspace
 * MCP discovery. Read tools and Gmail draft creation may appear dynamically;
 * effectful tools remain available only to typed policy-owning consumers.
 */
import type { ConnectorAccount } from "@elizaos/core";
import {
  type Action,
  type ActionParameter,
  type ActionParameterSchema,
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
import {
  GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES,
  GOOGLE_WORKSPACE_MCP_RESOURCES,
  type GoogleWorkspaceMcpResourceProduct,
} from "@elizaos/shared/contracts";

type Tool = McpDiscovery["tools"][number];

export const GOOGLE_MCP_PRODUCT_ENDPOINTS = Object.fromEntries(
  Object.entries(GOOGLE_WORKSPACE_MCP_RESOURCES).map(([product, resource]) => [
    product,
    resource.endpoint,
  ])
) as Record<GoogleWorkspaceMcpResourceProduct, string>;

export type GoogleMcpProduct = GoogleWorkspaceMcpResourceProduct;

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
  tools: Map<string, Tool>;
  capabilities: Map<string, string>;
}

interface MaterializedTool {
  product: GoogleMcpProduct;
  toolName: string;
  actionName: string;
  requiredCapability: string;
  tool: Tool;
}

const ACCOUNT_PARAMETER: ActionParameter = {
  name: "accountId",
  description: "Connected Google account identifier. Omit to use the default account.",
  required: false,
  schema: { type: "string", minLength: 1 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function selectedProducts(account: ConnectorAccount): GoogleMcpProduct[] {
  const selected = new Set(
    (account.selectedProducts ?? []).map((value) => {
      const normalized = value.trim().toLowerCase().replaceAll("-", "");
      return normalized === "workspace" || normalized === "universalsearch"
        ? "universalsearch"
        : normalized;
    })
  );
  return (Object.keys(GOOGLE_MCP_PRODUCT_ENDPOINTS) as GoogleMcpProduct[]).filter((product) =>
    selected.has(product.toLowerCase())
  );
}

function accountSupports(account: ConnectorAccount, capability: string): boolean {
  return account.status === "connected" && (account.capabilities ?? []).includes(capability);
}

function accountCanUseTool(
  account: ConnectorAccount,
  product: GoogleMcpProduct,
  toolName: string,
  capability: string
): boolean {
  const resource = GOOGLE_WORKSPACE_MCP_RESOURCES[product];
  const toolScopes =
    "toolScopes" in resource
      ? (resource.toolScopes as Partial<Record<string, readonly string[]>>)[toolName]
      : undefined;
  const capabilityScopes = GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES[
    capability as keyof typeof GOOGLE_WORKSPACE_MCP_CAPABILITY_SCOPES
  ] as readonly string[] | undefined;
  const accepted = toolScopes ?? capabilityScopes ?? [];
  const granted = new Set(account.scopes ?? []);
  return accepted.some((scope) => granted.has(scope));
}

function dynamicallyExposed(product: GoogleMcpProduct, toolName: string): boolean {
  const promoted = GOOGLE_WORKSPACE_MCP_RESOURCES[product].promotedTools as readonly string[];
  return promoted.includes(toolName);
}

function actionName(product: GoogleMcpProduct, toolName: string): string {
  const productName = product.replace(/([a-z])([A-Z])/g, "$1_$2");
  return normalizeActionName(`GOOGLE_${productName}_${toolName}`);
}

function actionParameters(tool: Tool): ActionParameter[] {
  const schema: Record<string, unknown> = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : []
  );
  return [
    ACCOUNT_PARAMETER,
    ...Object.entries(properties).flatMap(([name, property]) => {
      if (!isRecord(property)) return [];
      const description =
        typeof property.description === "string"
          ? property.description
          : `Input for Google MCP tool ${tool.name}.`;
      return [
        {
          name,
          description,
          required: required.has(name),
          schema: { ...property } as ActionParameterSchema,
        },
      ];
    }),
  ];
}

function parametersFromOptions(options: unknown): Record<string, unknown> {
  return isRecord(options) && isRecord(options.parameters) ? options.parameters : {};
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
    : "Google MCP returned no content.";
}

export class GoogleMcpCapabilityHost {
  private readonly active = new Map<string, ActiveGoogleMcpProduct>();
  private readonly connecting = new Map<string, Promise<GoogleMcpProductConnectionReport>>();
  private readonly ownedActions = new Map<string, Action>();
  private readonly stopController = new AbortController();

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly options: GoogleMcpCapabilityHostOptions
  ) {}

  async connectAccount(account: ConnectorAccount): Promise<GoogleMcpAccountConnectionReport> {
    await this.disconnectAccount(account.id);
    const report: GoogleMcpAccountConnectionReport = { accountId: account.id, products: {} };
    const products = selectedProducts(account);
    const productReports = await Promise.all(
      products.map(
        async (product) => [product, await this.connectProduct(account, product)] as const
      )
    );
    for (const [product, productReport] of productReports) {
      report.products[product] = productReport;
    }
    this.reconcileActions();
    return report;
  }

  async connectProduct(
    account: ConnectorAccount,
    product: GoogleMcpProduct
  ): Promise<GoogleMcpProductConnectionReport> {
    if (this.stopController.signal.aborted) {
      return {
        status: "error",
        discoveredTools: [],
        promotedActions: [],
        error: "Google MCP capability host is stopped",
      };
    }
    const key = this.activeKey(account.id, product);
    const active = this.active.get(key);
    if (active) {
      return {
        status: "connected",
        discoveredTools: [...active.tools.keys()],
        promotedActions: [...active.capabilities]
          .filter(([toolName]) => dynamicallyExposed(product, toolName))
          .map(([toolName]) => actionName(product, toolName)),
      };
    }
    const pending = this.connecting.get(key);
    if (pending) return pending;

    const connection = this.connectProductOnce(account, product);
    this.connecting.set(key, connection);
    try {
      return await connection;
    } finally {
      if (this.connecting.get(key) === connection) this.connecting.delete(key);
    }
  }

  private async connectProductOnce(
    account: ConnectorAccount,
    product: GoogleMcpProduct
  ): Promise<GoogleMcpProductConnectionReport> {
    if (!selectedProducts(account).includes(product)) {
      return { status: "skipped", discoveredTools: [], promotedActions: [] };
    }
    const resource = GOOGLE_WORKSPACE_MCP_RESOURCES[product];
    const allowedCapabilities = new Set(account.capabilities ?? []);
    const expectedTools = Object.entries(resource.tools)
      .filter(([, capability]) => allowedCapabilities.has(capability))
      .filter(([toolName, capability]) =>
        accountCanUseTool(account, product, toolName, capability)
      );
    if (expectedTools.length === 0) {
      return { status: "skipped", discoveredTools: [], promotedActions: [] };
    }

    let ref: McpAttachmentRef | undefined;
    try {
      ref = await this.options.engine.attach({
        key: `google:${String(this.runtime.agentId)}:${account.id}:${product}`,
        endpoint: resource.endpoint,
        auth: this.options.accessTokenProviderFor(account, product),
      });
      const discovery = await this.options.engine.discover(ref, {
        signal: this.stopController.signal,
      });
      if (this.stopController.signal.aborted) {
        throw new ElizaError("Google MCP capability host stopped during discovery", {
          code: "GOOGLE_MCP_HOST_STOPPED",
          context: { accountId: account.id, product },
        });
      }
      const tools = new Map(discovery.tools.map((tool) => [tool.name, tool]));
      const capabilities = new Map<string, string>();
      for (const [toolName, capability] of expectedTools) {
        if (tools.has(toolName)) capabilities.set(toolName, capability);
      }
      this.active.set(this.activeKey(account.id, product), {
        account,
        product,
        ref,
        tools,
        capabilities,
      });
      this.reconcileActions();
      return {
        status: "connected",
        discoveredTools: [...tools.keys()],
        promotedActions: [...capabilities]
          .filter(([toolName]) => dynamicallyExposed(product, toolName))
          .map(([toolName]) => actionName(product, toolName)),
      };
    } catch (error) {
      if (ref) await this.detachBestEffort(ref, account.id, product);
      return {
        status: "error",
        discoveredTools: [],
        promotedActions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
    this.stopController.abort();
    const accountIds = new Set([...this.active.values()].map((active) => active.account.id));
    for (const accountId of accountIds) await this.disconnectAccount(accountId);
  }

  async callTool(args: {
    accountId: string;
    product: GoogleMcpProduct;
    toolName: string;
    arguments?: Readonly<Record<string, unknown>>;
  }): Promise<GoogleMcpCapabilityCall> {
    const active = this.active.get(this.activeKey(args.accountId, args.product));
    const capability = active?.capabilities.get(args.toolName);
    if (!active || !capability || !active.tools.has(args.toolName)) {
      throw new ElizaError(`Google MCP tool ${args.product}/${args.toolName} is unavailable`, {
        code: "GOOGLE_MCP_CAPABILITY_UNAVAILABLE",
        context: { accountId: args.accountId, product: args.product, toolName: args.toolName },
      });
    }
    if (!(await this.options.authorizeAccount(args.accountId, capability))) {
      throw new ElizaError(`Google account ${args.accountId} is no longer authorized`, {
        code: "GOOGLE_MCP_ACCOUNT_NOT_AUTHORIZED",
        context: { accountId: args.accountId, capability },
      });
    }
    return {
      accountId: args.accountId,
      product: args.product,
      result: await this.options.engine.callTool(active.ref, {
        name: args.toolName,
        arguments: { ...(args.arguments ?? {}) },
      }),
    };
  }

  async callCapability(
    requestedActionName: string,
    accountId: string,
    arguments_: Readonly<Record<string, unknown>>
  ): Promise<GoogleMcpCapabilityCall | null> {
    const materialized = this.materializedTools().find(
      (candidate) =>
        normalizeActionName(candidate.actionName) === normalizeActionName(requestedActionName)
    );
    return materialized
      ? this.callTool({
          accountId,
          product: materialized.product,
          toolName: materialized.toolName,
          arguments: arguments_,
        })
      : null;
  }

  private activeKey(accountId: string, product: GoogleMcpProduct): string {
    return `${accountId}:${product}`;
  }

  private materializedTools(): MaterializedTool[] {
    const materialized: MaterializedTool[] = [];
    const seen = new Set<string>();
    const resources = [...this.active.values()].sort(
      (left, right) =>
        Number(Boolean(right.account.isDefault)) - Number(Boolean(left.account.isDefault)) ||
        left.account.id.localeCompare(right.account.id)
    );
    for (const active of resources) {
      for (const [toolName, requiredCapability] of active.capabilities) {
        if (!dynamicallyExposed(active.product, toolName)) continue;
        const stableName = actionName(active.product, toolName);
        if (seen.has(stableName)) continue;
        const tool = active.tools.get(toolName);
        if (!tool) continue;
        seen.add(stableName);
        materialized.push({
          product: active.product,
          toolName,
          actionName: stableName,
          requiredCapability,
          tool,
        });
      }
    }
    return materialized;
  }

  private reconcileActions(): void {
    const desired = new Map(
      this.materializedTools().map((tool) => [normalizeActionName(tool.actionName), tool] as const)
    );
    for (const [name, action] of this.ownedActions) {
      if (desired.has(name)) continue;
      if (this.runtime.actions.some((candidate) => candidate === action)) {
        this.runtime.unregisterAction(action.name);
      }
      this.ownedActions.delete(name);
    }
    for (const [name, materialized] of desired) {
      if (this.ownedActions.has(name)) continue;
      if (this.runtime.actions.some((action) => normalizeActionName(action.name) === name)) {
        logger.warn(
          { actionName: materialized.actionName },
          "[GoogleMcpCapabilityHost] action collision; keeping incumbent"
        );
        continue;
      }
      const action = this.buildAction(materialized);
      this.runtime.registerAction(action);
      if (this.runtime.actions.some((candidate) => candidate === action)) {
        this.ownedActions.set(name, action);
      }
    }
  }

  private buildAction(materialized: MaterializedTool): Action {
    return {
      name: materialized.actionName,
      description:
        materialized.tool.description ??
        `Use the ${materialized.toolName} tool on a connected Google ${materialized.product} account.`,
      contexts: ["connectors", "automation", "documents"],
      parameters: actionParameters(materialized.tool),
      connectorAccountPolicy: {
        provider: "google",
        statuses: ["connected"],
        roles: ["OWNER", "AGENT", "TEAM"],
        accessGates: ["open", "owner_binding", "manual_approval"],
        requiredCapabilities: [materialized.requiredCapability],
      },
      validate: async (_runtime, _message, _state, options) => {
        const requested = parametersFromOptions(options).accountId;
        return this.selectResource(materialized, requested) !== undefined;
      },
      handler: async (_runtime, _message, _state, options) => {
        const parameters = parametersFromOptions(options);
        const active = this.selectResource(materialized, parameters.accountId);
        if (!active) {
          return { success: false, error: "No connected Google account can run this MCP tool." };
        }
        const toolArguments = Object.fromEntries(
          Object.entries(parameters).filter(
            ([key, value]) => key !== "accountId" && value !== undefined
          )
        );
        try {
          const execution = await this.callTool({
            accountId: active.account.id,
            product: materialized.product,
            toolName: materialized.toolName,
            arguments: toolArguments,
          });
          return {
            success: execution.result.isError !== true,
            text: resultText(execution.result),
            transcriptVisibility: "internal",
            data: {
              accountId: execution.accountId,
              product: execution.product,
            },
            ...(execution.result.isError ? { error: resultText(execution.result) } : {}),
          };
        } catch (error) {
          // error-policy:J1 The action is the planner boundary for the exact
          // vendor tool failure and must never fabricate success.
          return { success: false, error: error instanceof Error ? error : String(error) };
        }
      },
    };
  }

  private selectResource(
    materialized: Pick<MaterializedTool, "product" | "toolName" | "requiredCapability">,
    requestedAccountId: unknown
  ): ActiveGoogleMcpProduct | undefined {
    return [...this.active.values()]
      .filter(
        (active) =>
          active.product === materialized.product &&
          active.capabilities.get(materialized.toolName) === materialized.requiredCapability &&
          accountSupports(active.account, materialized.requiredCapability) &&
          (typeof requestedAccountId !== "string" ||
            !requestedAccountId.trim() ||
            active.account.id === requestedAccountId.trim())
      )
      .sort(
        (left, right) =>
          Number(Boolean(right.account.isDefault)) - Number(Boolean(left.account.isDefault)) ||
          left.account.id.localeCompare(right.account.id)
      )[0];
  }

  private async detachBestEffort(
    ref: McpAttachmentRef,
    accountId: string,
    product: GoogleMcpProduct
  ): Promise<void> {
    try {
      await this.options.engine.detach(ref);
    } catch (error) {
      // error-policy:J6 Local exposure is already revoked; remote teardown is
      // best effort and cannot re-authorize a detached binding.
      logger.warn(
        { error, accountId, product },
        "[GoogleMcpCapabilityHost] failed to detach MCP resource"
      );
    }
  }
}
