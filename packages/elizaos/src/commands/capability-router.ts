import pc from "picocolors";

export interface CapabilityRouterConnectOptions {
  apiBase?: string;
  apiToken?: string;
  endpointUrl?: string;
  endpointId?: string;
  endpointToken?: string;
  cloudApiBase?: string;
  cloudAuthToken?: string;
  cloudAgentName?: string;
  cloudBio?: string[];
  cloudEndpointToken?: string;
  unloadMissing?: boolean;
  keepMissing?: boolean;
  persist?: boolean;
  requestTimeoutMs?: string;
  provisionTimeoutMs?: string;
  pollIntervalMs?: string;
  allowedModule?: string[];
  json?: boolean;
}

type ConnectPayload = {
  endpoint?: {
    id?: string;
    baseUrl: string;
    token?: string;
  };
  cloud?: {
    cloudApiBase: string;
    authToken: string;
    name: string;
    bio?: string[];
    endpointId?: string;
    token?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    allowedModuleIds?: string[];
  };
  allowedModuleIds?: string[];
  unloadMissing?: boolean;
  persist?: boolean;
  requestTimeoutMs?: number;
};

export async function runCapabilityRouterConnect(
  options: CapabilityRouterConnectOptions,
): Promise<number> {
  const apiBase = normalizeBaseUrl(
    options.apiBase ??
      process.env.ELIZA_API_BASE_URL ??
      process.env.ELIZA_API_BASE ??
      `http://127.0.0.1:${process.env.ELIZA_API_PORT ?? process.env.ELIZA_PORT ?? "2138"}`,
    "api base",
  );
  if (apiBase instanceof Error) {
    return fail(options, apiBase.message);
  }

  const payload = buildConnectPayload(options);
  if (payload instanceof Error) {
    return fail(options, payload.message);
  }

  const apiToken = options.apiToken ?? process.env.ELIZA_API_TOKEN;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (apiToken?.trim()) {
    headers.authorization = `Bearer ${apiToken.trim()}`;
  }

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/capability-router/connect`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return fail(
      options,
      `Failed to call agent API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await response.text();
  const data = parseJson(text);
  if (!response.ok) {
    const message =
      readErrorMessage(data) || `Agent API returned HTTP ${response.status}.`;
    return fail(options, message);
  }

  if (options.json) {
    console.log(JSON.stringify(data ?? {}, null, 2));
    return 0;
  }

  const result = isRecord(data) ? data : {};
  const endpoint = isRecord(result.endpoint) ? result.endpoint : {};
  const sync = isRecord(result.sync) ? result.sync : {};
  console.log(pc.bold(pc.green("Capability router connected")));
  console.log(
    `Endpoint: ${String(endpoint.id ?? "unknown")} (${String(endpoint.baseUrl ?? "unknown")})`,
  );
  if (typeof result.agentId === "string") {
    console.log(`Cloud agent: ${result.agentId}`);
  }
  console.log(
    `Plugins: registered ${countArray(sync.registered)}, unloaded ${countArray(
      sync.unloaded,
    )}, skipped ${countArray(sync.skipped)}`,
  );
  return 0;
}

export function capabilityRouterConnect(
  options: CapabilityRouterConnectOptions,
): void {
  runCapabilityRouterConnect(options).then((code) => process.exit(code));
}

function buildConnectPayload(
  options: CapabilityRouterConnectOptions,
): ConnectPayload | Error {
  const requestTimeoutMs = parsePositiveInteger(
    options.requestTimeoutMs,
    "request timeout",
  );
  if (requestTimeoutMs instanceof Error) return requestTimeoutMs;
  const unloadMissing = options.keepMissing
    ? false
    : (options.unloadMissing ?? true);
  const allowedModuleIds = normalizeStringList(options.allowedModule);
  const base = {
    unloadMissing,
    persist: options.persist ?? true,
    ...(allowedModuleIds.length === 0 ? {} : { allowedModuleIds }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };

  if (options.endpointUrl) {
    if (options.cloudApiBase || options.cloudAuthToken) {
      return new Error(
        "Use either --endpoint-url or --cloud-api-base, not both.",
      );
    }
    const baseUrl = normalizeBaseUrl(options.endpointUrl, "endpoint URL");
    if (baseUrl instanceof Error) return baseUrl;
    return {
      ...base,
      endpoint: {
        baseUrl,
        ...(nonEmpty(options.endpointId) ? { id: options.endpointId } : {}),
        ...(nonEmpty(options.endpointToken)
          ? { token: options.endpointToken }
          : {}),
      },
    };
  }

  if (
    options.cloudApiBase ||
    options.cloudAuthToken ||
    options.cloudAgentName
  ) {
    const cloudApiBase = normalizeBaseUrl(
      options.cloudApiBase,
      "cloud API base",
    );
    if (cloudApiBase instanceof Error) return cloudApiBase;
    if (!nonEmpty(options.cloudAuthToken)) {
      return new Error(
        "--cloud-auth-token is required for Cloud provisioning.",
      );
    }
    if (!nonEmpty(options.cloudAgentName)) {
      return new Error(
        "--cloud-agent-name is required for Cloud provisioning.",
      );
    }
    const timeoutMs = parsePositiveInteger(
      options.provisionTimeoutMs,
      "provision timeout",
    );
    if (timeoutMs instanceof Error) return timeoutMs;
    const pollIntervalMs = parsePositiveInteger(
      options.pollIntervalMs,
      "poll interval",
    );
    if (pollIntervalMs instanceof Error) return pollIntervalMs;
    return {
      ...base,
      cloud: {
        cloudApiBase,
        authToken: options.cloudAuthToken.trim(),
        name: options.cloudAgentName.trim(),
        ...(options.cloudBio?.length ? { bio: options.cloudBio } : {}),
        ...(nonEmpty(options.endpointId)
          ? { endpointId: options.endpointId }
          : {}),
        ...(nonEmpty(options.cloudEndpointToken)
          ? { token: options.cloudEndpointToken }
          : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
        ...(allowedModuleIds.length === 0 ? {} : { allowedModuleIds }),
      },
    };
  }

  return new Error("Provide --endpoint-url or Cloud provisioning options.");
}

function normalizeBaseUrl(
  value: string | undefined,
  label: string,
): string | Error {
  if (!nonEmpty(value)) {
    return new Error(`${label} is required.`);
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return new Error(`${label} must use http or https.`);
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return new Error(`${label} must be a valid URL.`);
  }
}

function parsePositiveInteger(
  value: string | undefined,
  label: string,
): number | undefined | Error {
  if (!nonEmpty(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function normalizeStringList(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function fail(
  options: CapabilityRouterConnectOptions,
  message: string,
): number {
  if (options.json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(pc.red(message));
  }
  return 1;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.error === "string" ? value.error : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
