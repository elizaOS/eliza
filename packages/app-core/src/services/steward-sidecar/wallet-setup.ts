/**
 * Steward Sidecar - first-launch wallet creation and verification.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fingerprintRandomToken, generateApiKey } from "./helpers";
import type { StewardCredentials, StewardSidecarStatus } from "./types";
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
  credentials: StewardCredentials | null,
  apiBase: string,
  masterPassword: string | undefined,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<StewardCredentials> {
  if (credentials?.walletAddress) {
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

async function verifyExistingWallet(
  credentials: StewardCredentials,
  apiBase: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<void> {
  try {
    const response = await fetch(`${apiBase}/agents/${credentials.agentId}`, {
      headers: {
        "X-Steward-Tenant": credentials.tenantId,
        "X-Steward-Key": credentials.tenantApiKey,
      },
    });

    if (response.ok) {
      const result = (await response.json()) as {
        ok: boolean;
        data?: { walletAddress?: string };
      };
      if (result.ok && result.data?.walletAddress) {
        console.log(
          `[StewardSidecar] Wallet verified: ${result.data.walletAddress}`,
        );
        updateStatus({ walletAddress: result.data.walletAddress });
        return;
      }
    }

    console.warn(
      "[StewardSidecar] Wallet verification returned unexpected result, continuing",
    );
  } catch (err) {
    console.warn(
      "[StewardSidecar] Wallet verification failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function performFirstLaunchSetup(
  apiBase: string,
  _masterPassword: string | undefined,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
): Promise<StewardCredentials> {
  console.log("[StewardSidecar] First launch - creating tenant and wallet");

  // 1. Create tenant
  const tenantApiKey = generateApiKey();
  const tenantResponse = await fetch(`${apiBase}/tenants`, {
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
  const agentResponse = await fetch(`${apiBase}/agents`, {
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

  // 3. Generate agent token
  const tokenResponse = await fetch(
    `${apiBase}/agents/${DEFAULT_AGENT_ID}/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Tenant": DEFAULT_TENANT_ID,
        "X-Steward-Key": tenantApiKey,
      },
    },
  );

  let agentToken = "";
  if (tokenResponse.ok) {
    const tokenResult = (await tokenResponse.json()) as {
      ok: boolean;
      data?: { token: string };
    };
    agentToken = tokenResult.data?.token ?? "";
  }

  // 4. Save credentials (never persist masterPassword to disk)
  const credentials: StewardCredentials = {
    tenantId: DEFAULT_TENANT_ID,
    tenantApiKey,
    agentId: DEFAULT_AGENT_ID,
    agentToken,
    walletAddress: agentResult.data.walletAddress,
    masterPassword: "",
  };

  const credPath = path.join(dataDir, CREDENTIALS_FILE);
  fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2), {
    mode: 0o600,
  });

  updateStatus({
    walletAddress: credentials.walletAddress,
    agentId: credentials.agentId,
    tenantId: credentials.tenantId,
  });

  console.log(`[StewardSidecar] Wallet created: ${credentials.walletAddress}`);

  return credentials;
}
