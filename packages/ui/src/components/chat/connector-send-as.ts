import type { ConnectorAccountRecord } from "../../api/client-agent";

export const CONNECTOR_SEND_AS_METADATA_KEY = "connectorSendAs";

export interface ConnectorSendAsContext {
  provider: string;
  connectorId?: string;
  source?: string;
  channel?: string;
  channelLabel?: string;
  writeCapable?: boolean;
  requiresAccount?: boolean;
}

export interface ConnectorSendAsSnapshot {
  accountId: string;
  source: string;
  channel?: string;
  provider: string;
  connectorId: string;
  label?: string;
  handle?: string | null;
  externalId?: string | null;
  status?: string;
  role?: string;
  purpose?: string[];
  privacy?: string;
  isDefault?: boolean;
}

export interface NormalizedConnectorSendAsContext
  extends ConnectorSendAsContext {
  provider: string;
  connectorId: string;
  source: string;
}

const ACCOUNT_REQUIRED_PATTERNS = [
  /account(?: id)? is required/i,
  /account.*required/i,
  /choose.*account/i,
  /select.*account/i,
  /ambiguous.*account/i,
  /cannot choose.*account/i,
  /missing connector account/i,
  /no connector account/i,
  /accountId/i,
];

export function normalizeConnectorSendAsContext(
  context: ConnectorSendAsContext | null | undefined,
): NormalizedConnectorSendAsContext | null {
  const provider = context?.provider?.trim();
  if (!provider) return null;
  const connectorId = context?.connectorId?.trim() || provider;
  return {
    ...context,
    provider,
    connectorId,
    source: context?.source?.trim() || connectorId,
  };
}

export function connectorAccountDisplayName(
  account: Pick<
    ConnectorAccountRecord,
    "label" | "handle" | "externalId" | "id"
  >,
): string {
  return (
    account.label?.trim() ||
    account.handle?.trim() ||
    account.externalId?.trim() ||
    account.id
  );
}

export function isConnectorAccountUsable(
  account: ConnectorAccountRecord | null | undefined,
): boolean {
  if (!account || account.enabled === false) return false;
  if (!account.status) return true;
  return account.status === "connected";
}

export function shouldShowConnectorAccountPicker(
  context: ConnectorSendAsContext | null | undefined,
  accounts: ConnectorAccountRecord[],
): boolean {
  return Boolean(
    normalizeConnectorSendAsContext(context) && accounts.length > 1,
  );
}

export function buildConnectorSendAsMetadata(
  context: ConnectorSendAsContext | null | undefined,
  account: ConnectorAccountRecord | null | undefined,
): Record<string, unknown> | undefined {
  const normalized = normalizeConnectorSendAsContext(context);
  if (!normalized || !account?.id) return undefined;

  const snapshot: ConnectorSendAsSnapshot = {
    accountId: account.id,
    source: normalized.source,
    provider: normalized.provider,
    connectorId: normalized.connectorId,
    ...(normalized.channel ? { channel: normalized.channel } : {}),
    ...(account.label ? { label: account.label } : {}),
    ...(account.handle !== undefined ? { handle: account.handle } : {}),
    ...(account.externalId !== undefined
      ? { externalId: account.externalId }
      : {}),
    ...(account.status ? { status: account.status } : {}),
    ...(account.role ? { role: account.role } : {}),
    ...(account.purpose?.length ? { purpose: account.purpose } : {}),
    ...(account.privacy ? { privacy: account.privacy } : {}),
    ...(account.isDefault !== undefined
      ? { isDefault: account.isDefault }
      : {}),
  };

  return {
    [CONNECTOR_SEND_AS_METADATA_KEY]: snapshot,
    connectorAccount: snapshot,
    accountId: account.id,
    source: normalized.source,
    ...(normalized.channel ? { channel: normalized.channel } : {}),
  };
}

export function mergeConnectorSendAsMetadata(
  metadata: Record<string, unknown> | undefined,
  sendAsMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!sendAsMetadata) return metadata;
  return {
    ...(metadata ?? {}),
    ...sendAsMetadata,
  };
}

export function connectorWriteConfirmationKey(
  context: ConnectorSendAsContext | null | undefined,
  account: ConnectorAccountRecord | null | undefined,
): string | null {
  const normalized = normalizeConnectorSendAsContext(context);
  if (!normalized || !account?.id) return null;
  return [normalized.source, normalized.channel ?? "default", account.id].join(
    ":",
  );
}

export function isLikelyAccountRequiredError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!message) return false;
  return ACCOUNT_REQUIRED_PATTERNS.some((pattern) => pattern.test(message));
}
