/**
 * Steward Sidecar - first-launch wallet creation and verification.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ElizaError, logger } from "@elizaos/core";
import { fingerprintRandomToken, generateApiKey } from "./helpers";

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

const STEWARD_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Durable state written before the tenant is registered, so the generated
 * tenant key survives a failed or interrupted agent-creation step and the next
 * launch resumes with it instead of registering the tenant again.
 */
export interface StewardTenantCheckpoint {
  tenantId: string;
  tenantApiKey: string;
  agentId?: undefined;
  agentToken?: undefined;
  walletAddress?: undefined;
  masterPassword?: string;
}

/** Where the Steward sidecar keeps its database; selects recovery guidance. */
export interface StewardStorageOptions {
  /** External Postgres connection string passed to the sidecar, if any. */
  databaseUrl?: string;
}

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

/**
 * Ensure wallet is set up: verify existing wallet or perform first-launch setup.
 */
export async function ensureWalletSetup(
  credentials: StewardCredentialCheckpoint | StewardTenantCheckpoint | null,
  apiBase: string,
  masterPassword: string | undefined,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
  platformKey?: string,
  storage: StewardStorageOptions = {},
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
    platformKey,
    storage,
    resumableTenantCheckpoint(credentials),
  );
}

function resumableTenantCheckpoint(
  credentials: StewardCredentialCheckpoint | StewardTenantCheckpoint | null,
): StewardTenantCheckpoint | null {
  if (
    credentials?.tenantId === DEFAULT_TENANT_ID &&
    typeof credentials.tenantApiKey === "string" &&
    credentials.tenantApiKey.trim()
  ) {
    return {
      tenantId: credentials.tenantId,
      tenantApiKey: credentials.tenantApiKey,
      ...(credentials.masterPassword
        ? { masterPassword: credentials.masterPassword }
        : {}),
    };
  }
  return null;
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
  credentials: StewardCredentialCheckpoint | StewardTenantCheckpoint,
  dataDir: string,
): void {
  const credPath = path.join(dataDir, CREDENTIALS_FILE);
  const temporary = path.join(dataDir, `.credentials-${randomUUID()}`);
  // Never truncate the only copy of a registered tenant key. Publish a complete,
  // flushed private replacement before the next remote setup operation starts.
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(credentials, null, 2));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, credPath);
    let directory: number | undefined;
    try {
      directory = fs.openSync(dataDir, "r");
      fs.fsyncSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Directory flush is unsupported on Windows and some filesystems; actual
      // I/O errors still stop setup, leaving a complete recoverable checkpoint.
      if (
        !(
          process.platform === "win32" &&
          (code === "EPERM" || code === "EACCES")
        ) &&
        code !== "EINVAL" &&
        code !== "ENOTSUP" &&
        code !== "EOPNOTSUPP" &&
        code !== "EISDIR"
      )
        throw error;
    } finally {
      if (directory !== undefined) fs.closeSync(directory);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

function tenantCredentialsLostError(
  dataDir: string,
  storage: StewardStorageOptions,
  status: number,
  serverError: string,
): ElizaError {
  const credPath = path.join(dataDir, CREDENTIALS_FILE);
  const usesExternalDatabase = Boolean(storage.databaseUrl?.trim());
  const stewardDbPath = path.join(dataDir, "data");
  // Never echo the connection string: it routinely embeds a password.
  const reset = usesExternalDatabase
    ? `reset the Steward Postgres database configured by DATABASE_URL (removing ${stewardDbPath} does not affect it)`
    : `reset the local Steward vault by removing ${stewardDbPath}`;
  return new ElizaError(
    `Steward tenant "${DEFAULT_TENANT_ID}" already exists but no local credentials hold its API key` +
      `${serverError ? ` (${serverError})` : ""}. ` +
      `Restore ${credPath} from a backup, or ${reset} ` +
      "(this permanently discards the existing wallet) and restart.",
    {
      code: "STEWARD_TENANT_CREDENTIALS_LOST",
      context: {
        tenantId: DEFAULT_TENANT_ID,
        status,
        credentialsPath: credPath,
        stewardDatabase: usesExternalDatabase ? "postgres" : "pglite",
        ...(usesExternalDatabase ? {} : { stewardDataPath: stewardDbPath }),
      },
      severity: "fatal",
    },
  );
}

function isAlreadyExists(status: number, serverError: string): boolean {
  return status === 409 || serverError.toLowerCase().includes("already exists");
}

/**
 * Register the tenant. Returns normally when the tenant is registered, or,
 * when resuming from a tenant checkpoint, when it already exists (the saved
 * key is then proven by the agent request that follows).
 */
async function registerTenant(
  apiBase: string,
  tenantApiKey: string,
  resuming: boolean,
  dataDir: string,
  storage: StewardStorageOptions,
  platformKey?: string,
): Promise<void> {
  const tenantResponse = await stewardFetch(`${apiBase}/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(platformKey ? { "X-Steward-Platform-Key": platformKey } : {}),
    },
    body: JSON.stringify({
      id: DEFAULT_TENANT_ID,
      name: DEFAULT_TENANT_NAME,
      apiKeyHash: fingerprintRandomToken(tenantApiKey),
    }),
  });
  if (tenantResponse.ok) return;

  let payload: unknown;
  try {
    payload = await tenantResponse.json();
  } catch (cause) {
    // error-policy:J2 the tenant endpoint is an external boundary; preserve
    // its parser failure while naming the setup step that cannot continue.
    throw new ElizaError(
      `Failed to create Steward tenant (HTTP ${tenantResponse.status}): response was not valid JSON`,
      {
        code: "STEWARD_TENANT_CREATE_FAILED",
        cause,
        context: {
          tenantId: DEFAULT_TENANT_ID,
          status: tenantResponse.status,
        },
        severity: "ephemeral",
      },
    );
  }
  const serverError =
    isRecord(payload) && typeof payload.error === "string"
      ? payload.error.trim()
      : "";
  if (isAlreadyExists(tenantResponse.status, serverError)) {
    // A resumed checkpoint holds the key this process registered earlier (the
    // previous attempt may have been cut off after the tenant was created).
    if (resuming) return;
    // The tenant's API key is only known to the process that registered it
    // and Steward exposes no path to rotate it. Continuing with a freshly
    // generated key would fail agent creation on every launch, so stop with
    // an actionable recovery message instead.
    throw tenantCredentialsLostError(
      dataDir,
      storage,
      tenantResponse.status,
      serverError,
    );
  }
  // Only a well-formed 4xx is a definitive rejection. A 5xx may have been
  // raised after the tenant was stored, so it proves nothing either way.
  const rejected = tenantResponse.status >= 400 && tenantResponse.status < 500;
  throw new ElizaError(
    `Failed to create Steward tenant (HTTP ${tenantResponse.status})${serverError ? `: ${serverError}` : ""}`,
    {
      code: "STEWARD_TENANT_CREATE_FAILED",
      context: {
        tenantId: DEFAULT_TENANT_ID,
        status: tenantResponse.status,
        rejected,
      },
      severity: "ephemeral",
    },
  );
}

function readAgentWallet(
  payload: unknown,
): { id: string; walletAddress: string } | null {
  const data =
    isRecord(payload) && payload.ok === true && isRecord(payload.data)
      ? payload.data
      : null;
  if (
    data &&
    typeof data.id === "string" &&
    data.id &&
    typeof data.walletAddress === "string" &&
    data.walletAddress
  ) {
    return { id: data.id, walletAddress: data.walletAddress };
  }
  return null;
}

async function readAgentPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    // error-policy:J2 the agent endpoint is an external boundary.
    throw new ElizaError(
      "Failed to create Steward agent: response was not valid JSON",
      {
        code: "STEWARD_AGENT_CREATE_FAILED",
        cause,
        context: { agentId: DEFAULT_AGENT_ID, status: response.status },
        severity: "ephemeral",
      },
    );
  }
}

/**
 * Create the wallet agent, or recover it when a previous attempt created it
 * but did not live to record the result.
 */
async function createOrRecoverAgent(
  apiBase: string,
  tenant: StewardTenantCheckpoint,
  resuming: boolean,
  dataDir: string,
  storage: StewardStorageOptions,
): Promise<{ id: string; walletAddress: string }> {
  const tenantHeaders = {
    "X-Steward-Tenant": tenant.tenantId,
    "X-Steward-Key": tenant.tenantApiKey,
  };
  const agentResponse = await stewardFetch(`${apiBase}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantHeaders },
    body: JSON.stringify({ id: DEFAULT_AGENT_ID, name: DEFAULT_AGENT_NAME }),
  });

  if (agentResponse.ok) {
    const agent = readAgentWallet(await readAgentPayload(agentResponse));
    if (!agent) {
      throw new ElizaError(
        "Failed to create Steward agent: response did not include the agent wallet",
        {
          code: "STEWARD_AGENT_CREATE_FAILED",
          context: { agentId: DEFAULT_AGENT_ID, status: agentResponse.status },
          severity: "fatal",
        },
      );
    }
    return agent;
  }

  const payload = await readAgentPayload(agentResponse);
  const serverError =
    isRecord(payload) && typeof payload.error === "string"
      ? payload.error.trim()
      : "";
  if (
    resuming &&
    (agentResponse.status === 401 || agentResponse.status === 403)
  ) {
    // The saved key does not authenticate: the existing tenant was registered
    // with a different key and cannot be recovered from this checkpoint.
    throw tenantCredentialsLostError(
      dataDir,
      storage,
      agentResponse.status,
      serverError,
    );
  }
  if (isAlreadyExists(agentResponse.status, serverError)) {
    const existing = await stewardFetch(
      `${apiBase}/agents/${DEFAULT_AGENT_ID}`,
      { headers: tenantHeaders },
    );
    const existingPayload = await readAgentPayload(existing);
    const agent = existing.ok ? readAgentWallet(existingPayload) : null;
    if (agent) return agent;
    throw new ElizaError(
      `Steward agent "${DEFAULT_AGENT_ID}" already exists but could not be read (HTTP ${existing.status})`,
      {
        code: "STEWARD_AGENT_CREATE_FAILED",
        context: { agentId: DEFAULT_AGENT_ID, status: existing.status },
        severity: "ephemeral",
      },
    );
  }
  throw new ElizaError(
    `Failed to create Steward agent (HTTP ${agentResponse.status})${serverError ? `: ${serverError}` : ""}`,
    {
      code: "STEWARD_AGENT_CREATE_FAILED",
      context: { agentId: DEFAULT_AGENT_ID, status: agentResponse.status },
      severity: "ephemeral",
    },
  );
}

async function performFirstLaunchSetup(
  apiBase: string,
  _masterPassword: string | undefined,
  dataDir: string,
  updateStatus: (partial: Partial<StewardSidecarStatus>) => void,
  platformKey: string | undefined,
  storage: StewardStorageOptions,
  resumeFrom: StewardTenantCheckpoint | null,
): Promise<StewardCredentials> {
  logger.info(
    resumeFrom
      ? "[StewardSidecar] Resuming interrupted setup with the saved tenant key"
      : "[StewardSidecar] First launch - creating tenant and wallet",
  );

  // 1. Persist the tenant key before registering it. Steward only stores its
  // hash, so a failure anywhere after registration (agent creation timing
  // out, a sidecar restart) must not lose the only copy of the key.
  const tenant: StewardTenantCheckpoint = resumeFrom ?? {
    tenantId: DEFAULT_TENANT_ID,
    tenantApiKey: generateApiKey(),
  };
  if (!resumeFrom) persistCredentials(tenant, dataDir);

  // 2. Register the tenant (idempotent when resuming).
  try {
    await registerTenant(
      apiBase,
      tenant.tenantApiKey,
      Boolean(resumeFrom),
      dataDir,
      storage,
      platformKey,
    );
  } catch (error) {
    // A definitive rejection (an existing tenant, or a well-formed 4xx)
    // proves Steward never stored this fresh key, so drop the checkpoint
    // rather than resume with it. Transport failures, 5xx, and unparsable
    // responses keep it: the tenant may have been created before the failure.
    if (
      !resumeFrom &&
      error instanceof ElizaError &&
      (error.code === "STEWARD_TENANT_CREDENTIALS_LOST" ||
        (error.code === "STEWARD_TENANT_CREATE_FAILED" &&
          error.context?.rejected === true))
    ) {
      fs.rmSync(path.join(dataDir, CREDENTIALS_FILE), { force: true });
    }
    throw error;
  }

  // 3. Create agent with wallet (or recover one a prior attempt created).
  const agent = await createOrRecoverAgent(
    apiBase,
    tenant,
    Boolean(resumeFrom),
    dataDir,
    storage,
  );

  // 4. Save an explicit incomplete checkpoint before requesting the token.
  const credentials: StewardCredentialCheckpoint = {
    ...tenant,
    agentId: agent.id,
    walletAddress: agent.walletAddress,
  };
  persistCredentials(credentials, dataDir);

  // 5. Complete and persist the required token. A failure leaves the explicit
  // checkpoint above so the next launch retries only this recoverable step.
  return completeAgentTokenSetup(credentials, apiBase, dataDir, updateStatus);
}
