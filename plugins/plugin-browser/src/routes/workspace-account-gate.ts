import {
  type ConnectorAccount,
  type ConnectorAccountAccessGate,
  type ConnectorAccountRole,
  type ConnectorAccountStatus,
  getAccountPrivacy,
  getConnectorAccountManager,
  type IAgentRuntime,
  type PrivacyLevel,
} from "@elizaos/core";
import {
  isConnectorBrowserWorkspacePartition,
  resolveConnectorBrowserWorkspacePartition,
} from "../workspace/browser-workspace-helpers.js";
import type { BrowserWorkspaceCommand } from "../workspace/browser-workspace-types.js";

const BROWSER_WORKSPACE_CONNECTOR_ROLES: ConnectorAccountRole[] = [
  "OWNER",
  "AGENT",
  "TEAM",
];
const BROWSER_WORKSPACE_CONNECTOR_STATUSES: ConnectorAccountStatus[] = [
  "connected",
];
const BROWSER_WORKSPACE_CONNECTOR_ACCESS_GATES: ConnectorAccountAccessGate[] = [
  "open",
  "owner_binding",
];
const BROWSER_WORKSPACE_CONNECTOR_PRIVACY_LEVELS: PrivacyLevel[] = [
  "owner_only",
  "team_visible",
];

export class BrowserWorkspaceConnectorAccountGateError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "BrowserWorkspaceConnectorAccountGateError";
    this.status = status;
    this.code = code;
  }
}

export interface BrowserWorkspaceConnectorAccountGateRequest {
  runtime?: IAgentRuntime | null;
  connectorProvider?: string | null;
  connectorAccountId?: string | null;
  partition?: string | null;
  operation?: string;
}

export interface BrowserWorkspaceConnectorAccountGateResult {
  account: ConnectorAccount;
  accountId: string;
  expectedPartition: string;
  partition: string | null;
  privacy: PrivacyLevel;
  provider: string;
}

function cleanString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function gateError(
  message: string,
  status: number,
  code: string,
): BrowserWorkspaceConnectorAccountGateError {
  return new BrowserWorkspaceConnectorAccountGateError(message, status, code);
}

function connectorReferenceRequested(
  request: BrowserWorkspaceConnectorAccountGateRequest,
): boolean {
  return Boolean(
    cleanString(request.connectorProvider) ||
      cleanString(request.connectorAccountId) ||
      isConnectorBrowserWorkspacePartition(request.partition),
  );
}

export async function assertBrowserWorkspaceConnectorAccountGate(
  request: BrowserWorkspaceConnectorAccountGateRequest,
): Promise<BrowserWorkspaceConnectorAccountGateResult | null> {
  if (!connectorReferenceRequested(request)) {
    return null;
  }

  const provider = cleanString(request.connectorProvider).toLowerCase();
  const accountId = cleanString(request.connectorAccountId);
  const partition = cleanString(request.partition);
  const operation = request.operation ?? "browser workspace";

  if (!provider || !accountId) {
    throw gateError(
      `Connector ${operation} requires connectorProvider and connectorAccountId.`,
      400,
      "browser_workspace_connector_account_required",
    );
  }

  const runtime = request.runtime ?? null;
  if (!runtime) {
    throw gateError(
      `Connector ${operation} requires an active agent runtime for account validation.`,
      503,
      "browser_workspace_connector_runtime_unavailable",
    );
  }

  const manager = getConnectorAccountManager(runtime);
  const account = await manager.getAccount(provider, accountId);
  if (!account) {
    throw gateError(
      `Connector account not found: ${provider}/${accountId}.`,
      404,
      "browser_workspace_connector_account_not_found",
    );
  }

  const policy = await manager.evaluatePolicy(
    {
      provider,
      roles: BROWSER_WORKSPACE_CONNECTOR_ROLES,
      statuses: BROWSER_WORKSPACE_CONNECTOR_STATUSES,
      accessGates: BROWSER_WORKSPACE_CONNECTOR_ACCESS_GATES,
      required: true,
    },
    { accountId },
  );
  if (!policy.allowed) {
    throw gateError(
      policy.reason ??
        `Connector account ${provider}/${accountId} is not allowed for ${operation}.`,
      403,
      "browser_workspace_connector_account_denied",
    );
  }

  const privacy = getAccountPrivacy(account);
  if (!BROWSER_WORKSPACE_CONNECTOR_PRIVACY_LEVELS.includes(privacy)) {
    throw gateError(
      `Connector account ${provider}/${accountId} privacy ${privacy} is not allowed for ${operation}.`,
      403,
      "browser_workspace_connector_account_privacy_denied",
    );
  }

  const expectedPartition = resolveConnectorBrowserWorkspacePartition(
    provider,
    accountId,
  );
  if (partition && partition !== expectedPartition) {
    throw gateError(
      `Connector ${operation} partition does not match connector account ${provider}/${accountId}.`,
      403,
      "browser_workspace_connector_partition_mismatch",
    );
  }

  return {
    account,
    accountId,
    expectedPartition,
    partition: partition || null,
    privacy,
    provider,
  };
}

export async function assertBrowserWorkspaceCommandConnectorAccountGate(args: {
  runtime?: IAgentRuntime | null;
  command: BrowserWorkspaceCommand;
  operation?: string;
}): Promise<void> {
  await assertBrowserWorkspaceConnectorAccountGate({
    runtime: args.runtime,
    connectorProvider: args.command.connectorProvider,
    connectorAccountId: args.command.connectorAccountId,
    partition: args.command.partition,
    operation: args.operation ?? `command ${args.command.subaction}`,
  });

  if (
    args.command.subaction !== "batch" ||
    !Array.isArray(args.command.steps)
  ) {
    return;
  }

  for (const step of args.command.steps) {
    await assertBrowserWorkspaceCommandConnectorAccountGate({
      runtime: args.runtime,
      command: step,
      operation: `batch command ${step.subaction}`,
    });
  }
}
