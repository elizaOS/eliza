/**
 * Wire and browser-storage contracts for handing a Cloud agent session from
 * the pairing exchange into the app boot path.
 */

export const CLOUD_PAIR_LEGACY_STORAGE_KEY = "eliza:cloud-pair:api-token";
export const CLOUD_PAIR_SCOPED_STORAGE_PREFIX = `${CLOUD_PAIR_LEGACY_STORAGE_KEY}:`;

const CLOUD_AGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CloudPairExchangeResponse {
  message: string;
  apiKey: string | null;
  agentName: string;
  agentId: string;
}

export interface CloudPairRelaySession {
  apiKey: string;
  agentId: string;
  agentName?: string;
}

/** The dedicated-agent identity format accepted at every pairing boundary. */
export function isCloudPairAgentId(value: unknown): value is string {
  return typeof value === "string" && CLOUD_AGENT_ID_PATTERN.test(value);
}

/**
 * Per-agent storage key for a durable Cloud-pair credential. The caller owns
 * identity validation because browser migration tests also exercise historic
 * non-UUID identifiers through this stable key-builder contract.
 */
export function cloudPairTokenKeyForAgent(agentId: string): string {
  return `${CLOUD_PAIR_SCOPED_STORAGE_PREFIX}${agentId}`;
}

/** Validate the successful dependency payload before a relay writes a bearer. */
export function parseCloudPairRelaySession(
  value: unknown,
): CloudPairRelaySession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.apiKey !== "string" ||
    !record.apiKey.trim() ||
    !isCloudPairAgentId(record.agentId)
  ) {
    return null;
  }

  return {
    apiKey: record.apiKey,
    agentId: record.agentId,
    ...(typeof record.agentName === "string"
      ? { agentName: record.agentName }
      : {}),
  };
}
