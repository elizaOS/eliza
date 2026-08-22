/**
 * Steward Sidecar - first-launch wallet creation and verification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { fingerprintRandomToken, generateApiKey } from "./helpers";

const STEWARD_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Bound every Steward sidecar API hop so a hung sidecar cannot pin
 * first-launch wallet setup. A caller-provided abort signal is composed with
 * the timeout (either cancelling aborts), not substituted for it.
 */
export function stewardFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = STEWARD_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal,
  });
}

import type {
  StewardCredentialCheckpoint,
  StewardCredentials,
  StewardSidecarStatus,
} from "./types";
import {
  CREDENTIALS_FILE,
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_NAME,
} from "./types";

/**
 * Ensure wallet is set up: verify existing wallet or perform first-launch setup.
 */
export async function ensureWalletSetup(
  credentials: StewardCredentialCheckpoint | null,
  apiBase: string,
  masterPassword: string | undefined,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<StewardCredentials> {
  if (credentials?.walletAddress) {
    if (!hasAgentToken(credentials)) {
      return completeAgentTokenSetup(
        credentials,
        apiBase,
        dataDir,
        updateStatus,
      );
    }
    await verifyExistingWallet(credentials, apiBase, updateStatus);
    return credentials;
  }

  return performFirstLaunchSetup(
    apiBase,
    masterPassword,
    dataDir,
    updateStatus,
  );
}

function hasAgentToken(
  credentials: StewardCredentialCheckpoint,
): credentials is StewardCredentials {
  return (
    typeof credentials.agentToken === "string" &&
    Boolean(credentials.agentToken.trim())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistCredentials(
  credentials: StewardCredentialCheckpoint,
  dataDir: string,
): void {
  const credPath = path.join(dataDir, CREDENTIALS_FILE);
  fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });
}

async function requestAgentToken(
  credentials: StewardCredentialCheckpoint,
  apiBase: string,
): Promise<string> {
  const tokenResponse = await stewardFetch(
    `${apiBase}/agents/${credentials.agentId}/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Tenant": credentials.tenantId,
        "X-Steward-Key": credentials.tenantApiKey,
      },
    },
  );

  let payload: unknown;
  try {
    payload = await tokenResponse.json();
  } catch (cause) {
    // error-policy:J2 the token endpoint is an external boundary; preserve its
    // parser failure while naming the setup step that cannot continue.
    throw new ElizaError(
      "Failed to generate agent token: response was not valid JSON",
      {
        code: "STEWARD_AGENT_TOKEN_RESPONSE_INVALID",
        cause,
        context: {
          agentId: credentials.agentId,
          status: tokenResponse.status,
        },
        severity: "ephemeral",
      },
    );
  }

  if (!tokenResponse.ok) {
    const serverError =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error.trim()
        : "";
    const suffix = serverError ? `: ${serverError}` : "";
    throw new ElizaError(
      `Failed to generate agent token (HTTP ${tokenResponse.status})${suffix}`,
      {
        code: "STEWARD_AGENT_TOKEN_REQUEST_FAILED",
        context: {
          agentId: credentials.agentId,
          status: tokenResponse.status,
        },
        severity: "ephemeral",
      },
    );
  }

  const data =
    isRecord(payload) && payload.ok === true && isRecord(payload.data)
      ? payload.data
      : null;
  const agentToken =
    data && typeof data.token === "string" ? data.token.trim() : "";
  if (!agentToken) {
    throw new ElizaError(
      "Failed to generate agent token: response did not include a token",
      {
        code: "STEWARD_AGENT_TOKEN_MISSING",
        context: { agentId: credentials.agentId },
        severity: "fatal",
      },
    );
  }
  return agentToken;
}

async function completeAgentTokenSetup(
  credentials: StewardCredentialCheckpoint,
  apiBase: string,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<StewardCredentials> {
  const agentToken = await requestAgentToken(credentials, apiBase);
  const completedCredentials: StewardCredentials = {
    ...credentials,
    agentToken,
  };
  persistCredentials(completedCredentials, dataDir);

  updateStatus({
    walletAddress: completedCredentials.walletAddress,
    agentId: completedCredentials.agentId,
    tenantId: completedCredentials.tenantId,
  });
  logger.info(
    `[StewardSidecar] Wallet created: ${completedCredentials.walletAddress}`,
  );
  return completedCredentials;
}

async function verifyExistingWallet(
  credentials: StewardCredentials,
  apiBase: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<void> {
  try {
    const response = await stewardFetch(
      `${apiBase}/agents/${credentials.agentId}`,
      {
        headers: {
          "X-Steward-Tenant": credentials.tenantId,
          "X-Steward-Key": credentials.tenantApiKey,
        },
      },
    );

    if (response.ok) {
      const result = (await response.json()) as {
        ok: boolean;
        data?: { walletAddress?: string };
      };
      if (result.ok && result.data?.walletAddress) {
        logger.info(
          `[StewardSidecar] Wallet verified: ${result.data.walletAddress}`,
        );
        updateStatus({ walletAddress: result.data.walletAddress });
        return;
      }
    }

    logger.warn(
      "[StewardSidecar] Wallet verification returned unexpected result, continuing",
    );
  } catch (err) {
    logger.warn(
      "[StewardSidecar] Wallet verification failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function performFirstLaunchSetup(
  apiBase: string,
  _masterPassword: string | undefined,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<StewardCredentials> {
  logger.info("[StewardSidecar] First launch - creating tenant and wallet");

  // 1. Create tenant
  const tenantApiKey = generateApiKey();
  const tenantResponse = await stewardFetch(`${apiBase}/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: DEFAULT_TENANT_ID,
      name: DEFAULT_TENANT_NAME,
      apiKeyHash: fingerprintRandomToken(tenantApiKey),
    }),
  });

  if (!tenantResponse.ok) {
    const body = (await tenantResponse.json()) as { error?: string };
    if (!body.error?.includes("already exists")) {
      throw new Error(`Failed to create tenant: ${body.error}`);
    }
  }

  // 2. Create agent with wallet
  const agentResponse = await stewardFetch(`${apiBase}/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Steward-Tenant": DEFAULT_TENANT_ID,
      "X-Steward-Key": tenantApiKey,
    },
    body: JSON.stringify({
      id: DEFAULT_AGENT_ID,
      name: DEFAULT_AGENT_NAME,
    }),
  });

  if (!agentResponse.ok) {
    const body = (await agentResponse.json()) as { error?: string };
    throw new Error(`Failed to create agent: ${body.error}`);
  }

  const agentResult = (await agentResponse.json()) as {
    ok: boolean;
    data?: { id: string; walletAddress: string };
  };

  if (!agentResult.ok || !agentResult.data) {
    throw new Error("Agent creation returned unexpected response");
  }

  // 3. Save an explicit incomplete checkpoint before requesting the token.
  // The tenant and agent already exist remotely, so losing their generated
  // tenant key here would make a later retry unable to authenticate.
  const credentials: StewardCredentialCheckpoint = {
    tenantId: DEFAULT_TENANT_ID,
    tenantApiKey,
    agentId: DEFAULT_AGENT_ID,
    walletAddress: agentResult.data.walletAddress,
  };
  persistCredentials(credentials, dataDir);

  // 4. Complete and persist the required token. A failure leaves the explicit
  // checkpoint above so the next launch retries only this recoverable step.
  return completeAgentTokenSetup(credentials, apiBase, dataDir, updateStatus);
}
