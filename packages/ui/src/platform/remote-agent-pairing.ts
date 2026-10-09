/**
 * Consumes the remote-agent pairing payload (`@elizaos/core`
 * remote-agent-pairing contract) in Remote mode, including the Android thin
 * client. The payload never carries a bearer token: the phone exchanges the
 * one-time code with the exact issuing instance and only then connects. The
 * origin must already be trusted by the app (for Alpha phones, the HTTPS
 * origin compiled in with VITE_ELIZA_REMOTE_FALLBACK_API_BASE).
 */
import {
  parseRemoteAgentPairingUri,
  type RemoteAgentPairingPayload,
} from "@elizaos/contracts";

export type RemoteAgentPairingFailure =
  | "REMOTE_AGENT_ORIGIN_UNTRUSTED"
  | "PAIRING_NOT_READY"
  | "PAIRING_INSTANCE_MISMATCH";

export class RemoteAgentPairingError extends Error {
  constructor(
    readonly code: RemoteAgentPairingFailure,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAgentPairingError";
  }
}

/** The subset of ElizaClient the exchange needs. */
export interface RemoteAgentPairingClient {
  setBaseUrl(baseUrl: string): void;
  setToken(token: string | null): void;
  getAuthStatus(): Promise<{ instanceId?: string; pairingEnabled?: boolean }>;
  pair(
    code: string,
    expectedInstanceId?: string,
  ): Promise<{ token: string; instanceId?: string }>;
}

export function parseRemoteAgentPairingDeepLink(
  rawUrl: string,
  urlScheme: string,
): RemoteAgentPairingPayload | null {
  return parseRemoteAgentPairingUri(rawUrl, urlScheme);
}

/**
 * Exchanges the code for the agent credential. Resolves with the origin and
 * server-issued token for the caller's normal connect path; rejects before any
 * network request for an untrusted origin and on a stale or foreign instance.
 */
export async function exchangeRemoteAgentPairing(
  payload: RemoteAgentPairingPayload,
  client: RemoteAgentPairingClient,
  isTrustedApiBase: (apiBase: string) => boolean,
): Promise<{ apiBase: string; token: string; instanceId: string }> {
  if (!isTrustedApiBase(payload.apiBase)) {
    throw new RemoteAgentPairingError(
      "REMOTE_AGENT_ORIGIN_UNTRUSTED",
      "This app is not configured to trust that agent address.",
    );
  }
  client.setBaseUrl(payload.apiBase);
  client.setToken(null);
  const status = await client.getAuthStatus();
  if (status.pairingEnabled === false || !status.instanceId) {
    throw new RemoteAgentPairingError(
      "PAIRING_NOT_READY",
      "The agent is not accepting pairing codes.",
    );
  }
  if (status.instanceId.toLowerCase() !== payload.instanceId) {
    throw new RemoteAgentPairingError(
      "PAIRING_INSTANCE_MISMATCH",
      "This pairing code belongs to a different or restarted agent. Request a new code.",
    );
  }
  const paired = await client.pair(payload.code, payload.instanceId);
  if (paired.instanceId?.toLowerCase() !== payload.instanceId) {
    throw new RemoteAgentPairingError(
      "PAIRING_INSTANCE_MISMATCH",
      "Pairing response came from a different server instance.",
    );
  }
  return {
    apiBase: payload.apiBase,
    token: paired.token,
    instanceId: payload.instanceId,
  };
}
