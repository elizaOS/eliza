import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { getWalletAddresses } from "../api/wallet";
import type {
  StewardApprovalActionResponse,
  StewardPendingApproval,
  StewardSignRequest,
  StewardSignResponse,
  StewardStatusResponse,
} from "../types/steward";

const DEFAULT_TIMEOUT_MS = 12_000;

function resolveStewardCredentialsPath(): string {
  return path.join(resolveStateDir(), "steward-credentials.json");
}

interface PersistedStewardCredentials {
  apiUrl: string;
  tenantId: string;
  agentId: string;
  apiKey: string;
  agentToken: string;
  walletAddresses?: {
    evm?: string;
    solana?: string;
  };
  agentName?: string;
}

interface EffectiveStewardConfig extends PersistedStewardCredentials {}

function normalizeEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePersistedStewardCredentials(): PersistedStewardCredentials | null {
  const credentialsPath = resolveStewardCredentialsPath();
  try {
    if (!fs.existsSync(credentialsPath)) {
      return null;
    }

    const parsed = JSON.parse(
      fs.readFileSync(credentialsPath, "utf8"),
    ) as Partial<PersistedStewardCredentials>;
    if (!normalizeEnvValue(parsed.apiUrl)) {
      return null;
    }

    return {
      apiUrl: normalizeEnvValue(parsed.apiUrl) ?? "",
      tenantId: normalizeEnvValue(parsed.tenantId) ?? "",
      agentId: normalizeEnvValue(parsed.agentId) ?? "",
      apiKey: normalizeEnvValue(parsed.apiKey) ?? "",
      agentToken: normalizeEnvValue(parsed.agentToken) ?? "",
      walletAddresses:
        parsed.walletAddresses &&
        typeof parsed.walletAddresses === "object" &&
        !Array.isArray(parsed.walletAddresses)
          ? parsed.walletAddresses
          : undefined,
      agentName: normalizeEnvValue(parsed.agentName ?? undefined) ?? undefined,
    };
  } catch {
    return null;
  }
}

export function resolveEffectiveStewardConfig(
  env: NodeJS.ProcessEnv = process.env,
): EffectiveStewardConfig | null {
  const persisted = resolvePersistedStewardCredentials();
  const apiUrl = normalizeEnvValue(env.STEWARD_API_URL) ?? persisted?.apiUrl;
  if (!apiUrl) {
    return null;
  }

  return {
    apiUrl,
    tenantId:
      normalizeEnvValue(env.STEWARD_TENANT_ID) ?? persisted?.tenantId ?? "",
    agentId:
      normalizeEnvValue(env.STEWARD_AGENT_ID) ??
      normalizeEnvValue(env.ELIZA_STEWARD_AGENT_ID) ??
      persisted?.agentId ??
      "",
    apiKey: normalizeEnvValue(env.STEWARD_API_KEY) ?? persisted?.apiKey ?? "",
    agentToken:
      normalizeEnvValue(env.STEWARD_AGENT_TOKEN) ?? persisted?.agentToken ?? "",
    walletAddresses: persisted?.walletAddresses,
    agentName: persisted?.agentName,
  };
}

function resolveStewardWalletAgentId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = resolveEffectiveStewardConfig(env);
  const addresses = getWalletAddresses();
  return (
    normalizeEnvValue(env.STEWARD_AGENT_ID) ??
    normalizeEnvValue(env.ELIZA_STEWARD_AGENT_ID) ??
    normalizeEnvValue(config?.agentId) ??
    normalizeEnvValue(addresses.evmAddress ?? undefined)
  );
}

function resolveStewardWalletBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveEffectiveStewardConfig(env)?.apiUrl ?? null;
}

export function isStewardWalletConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    resolveStewardWalletBaseUrl(env) && resolveStewardWalletAgentId(env),
  );
}

export function getStewardWalletUnavailableMessage(): string {
  return "Eliza agent wallet is unavailable. Configure Steward in Eliza wallet settings or set STEWARD_API_URL and Steward credentials.";
}

function buildStewardWalletHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Headers {
  const config = resolveEffectiveStewardConfig(env);
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");

  const bearerToken =
    normalizeEnvValue(env.STEWARD_AGENT_TOKEN) ?? config?.agentToken ?? null;
  const apiKey =
    normalizeEnvValue(env.STEWARD_API_KEY) ?? config?.apiKey ?? null;
  const tenantId =
    normalizeEnvValue(env.STEWARD_TENANT_ID) ?? config?.tenantId ?? null;

  if (bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  } else if (apiKey) {
    headers.set("X-Steward-Key", apiKey);
  }
  if (tenantId) {
    headers.set("X-Steward-Tenant", tenantId);
  }
  return headers;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 240);
  } catch {
    return "";
  }
}

async function requestStewardWallet(
  pathname: string,
  init?: RequestInit,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const baseUrl = resolveStewardWalletBaseUrl(env);
  if (!baseUrl) {
    throw new Error(getStewardWalletUnavailableMessage());
  }

  return fetch(`${baseUrl.replace(/\/{1,1024}$/, "")}${pathname}`, {
    ...init,
    headers: init?.headers ?? buildStewardWalletHeaders(env),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
}

function resolveWalletAddresses(
  _env: NodeJS.ProcessEnv,
  config: EffectiveStewardConfig | null,
  agentRecord?: Record<string, unknown> | null,
): { evm: string | null; solana: string | null } {
  const localAddresses = getWalletAddresses();
  const remoteWalletAddresses =
    agentRecord?.walletAddresses &&
    typeof agentRecord.walletAddresses === "object" &&
    !Array.isArray(agentRecord.walletAddresses)
      ? (agentRecord.walletAddresses as Record<string, unknown>)
      : null;
  const remoteEvm =
    normalizeEnvValue(
      typeof remoteWalletAddresses?.evm === "string"
        ? remoteWalletAddresses.evm
        : undefined,
    ) ??
    normalizeEnvValue(
      typeof agentRecord?.walletAddress === "string"
        ? agentRecord.walletAddress
        : undefined,
    );
  const remoteSolana = normalizeEnvValue(
    typeof remoteWalletAddresses?.solana === "string"
      ? remoteWalletAddresses.solana
      : undefined,
  );

  return {
    evm:
      localAddresses.evmAddress ??
      remoteEvm ??
      config?.walletAddresses?.evm?.trim() ??
      null,
    solana:
      localAddresses.solanaAddress ??
      remoteSolana ??
      config?.walletAddresses?.solana?.trim() ??
      null,
  };
}

export async function getStewardWalletStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StewardStatusResponse> {
  const config = resolveEffectiveStewardConfig(env);
  const agentId = resolveStewardWalletAgentId(env);
  const localAddresses = getWalletAddresses();
  const fallbackWalletAddresses = {
    evm:
      localAddresses.evmAddress ?? config?.walletAddresses?.evm?.trim() ?? null,
    solana:
      localAddresses.solanaAddress ??
      config?.walletAddresses?.solana?.trim() ??
      null,
  };

  if (!config?.apiUrl || !agentId) {
    return {
      configured: false,
      available: false,
      connected: false,
      baseUrl: config?.apiUrl ?? undefined,
      agentId: agentId ?? undefined,
      agentName: config?.agentName,
      evmAddress: fallbackWalletAddresses.evm ?? undefined,
      walletAddresses: fallbackWalletAddresses,
      error: null,
    };
  }

  try {
    const response = await requestStewardWallet(
      `/agents/${encodeURIComponent(agentId)}`,
      undefined,
      env,
    );

    if (!response.ok) {
      const details = await readErrorBody(response);
      return {
        configured: true,
        available: true,
        connected: false,
        baseUrl: config.apiUrl,
        agentId,
        agentName: config.agentName,
        evmAddress: fallbackWalletAddresses.evm ?? undefined,
        walletAddresses: fallbackWalletAddresses,
        error: `Steward agent lookup failed (${response.status})${details ? `: ${details}` : ""}`,
      };
    }

    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const agentRecord =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : body;
    const walletAddresses = resolveWalletAddresses(env, config, agentRecord);

    return {
      configured: true,
      available: true,
      connected: true,
      baseUrl: config.apiUrl,
      agentId,
      agentName:
        normalizeEnvValue(
          typeof agentRecord.name === "string" ? agentRecord.name : undefined,
        ) ?? config.agentName,
      evmAddress: walletAddresses.evm ?? undefined,
      walletAddresses,
      error: null,
      vaultHealth: "ok",
    };
  } catch (error) {
    return {
      configured: true,
      available: true,
      connected: false,
      baseUrl: config.apiUrl,
      agentId,
      agentName: config.agentName,
      evmAddress: fallbackWalletAddresses.evm ?? undefined,
      walletAddresses: fallbackWalletAddresses,
      error: error instanceof Error ? error.message : String(error),
      vaultHealth: "error",
    };
  }
}

export async function getStewardPendingApprovals(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StewardPendingApproval[]> {
  const agentId = resolveStewardWalletAgentId(env);
  if (!agentId) {
    throw new Error(getStewardWalletUnavailableMessage());
  }

  const response = await requestStewardWallet(
    `/vault/${encodeURIComponent(agentId)}/pending`,
    undefined,
    env,
  );
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(
      `Steward pending approvals failed (${response.status})${details ? `: ${details}` : ""}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const data = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : [];
  return data as StewardPendingApproval[];
}

export async function approveStewardWalletRequest(
  txId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StewardApprovalActionResponse> {
  const agentId = resolveStewardWalletAgentId(env);
  if (!agentId) {
    throw new Error(getStewardWalletUnavailableMessage());
  }

  const response = await requestStewardWallet(
    `/vault/${encodeURIComponent(agentId)}/approve/${encodeURIComponent(txId)}`,
    { method: "POST" },
    env,
  );
  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(
      `Steward approve failed (${response.status})${details ? `: ${details}` : ""}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const payload =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;

  return {
    ok: true,
    txHash: typeof payload.txHash === "string" ? payload.txHash : undefined,
  };
}

export async function rejectStewardWalletRequest(
  txId: string,
  reason?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StewardApprovalActionResponse> {
  const agentId = resolveStewardWalletAgentId(env);
  if (!agentId) {
    throw new Error(getStewardWalletUnavailableMessage());
  }

  const response = await requestStewardWallet(
    `/vault/${encodeURIComponent(agentId)}/reject/${encodeURIComponent(txId)}`,
    {
      method: "POST",
      body: JSON.stringify(reason?.trim() ? { reason } : {}),
    },
    env,
  );
  if (!response.ok) {
    const details = await readErrorBody(response);
    throw new Error(
      `Steward reject failed (${response.status})${details ? `: ${details}` : ""}`,
    );
  }

  return { ok: true };
}

function normalizeViolations(
  raw: unknown,
): Array<{ policy: string; reason: string }> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  return raw
    .filter(
      (entry): entry is { policy: string; reason: string } =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).policy === "string" &&
        typeof (entry as Record<string, unknown>).reason === "string",
    )
    .map((entry) => ({
      policy: entry.policy,
      reason: entry.reason,
    }));
}

export async function signWithStewardWallet(
  request: StewardSignRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StewardSignResponse> {
  const agentId = resolveStewardWalletAgentId(env);
  if (!agentId) {
    throw new Error(getStewardWalletUnavailableMessage());
  }

  const response = await requestStewardWallet(
    `/vault/${encodeURIComponent(agentId)}/sign`,
    {
      method: "POST",
      body: JSON.stringify({
        to: request.to,
        value: request.value,
        chainId: request.chainId,
        data: request.data,
        broadcast: request.broadcast ?? true,
        description: request.description,
      }),
    },
    env,
  );

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const payload =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;

  if (response.ok && body.ok === true) {
    return {
      approved: true,
      txHash: typeof payload.txHash === "string" ? payload.txHash : undefined,
    };
  }

  if (response.status === 202) {
    return {
      approved: false,
      pending: true,
      txId: typeof payload.txId === "string" ? payload.txId : undefined,
      violations: normalizeViolations(payload.violations),
    };
  }

  if (response.status === 403) {
    return {
      approved: false,
      denied: true,
      violations: normalizeViolations(payload.violations),
    };
  }

  throw new Error(
    typeof body.error === "string"
      ? body.error
      : `Steward sign failed (${response.status})`,
  );
}
