import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

const CONTROL_PLANE_URL_KEYS = [
  "CONTAINER_CONTROL_PLANE_URL",
  "CONTAINER_SIDECAR_URL",
  "HETZNER_CONTAINER_CONTROL_PLANE_URL",
] as const;

export type ProvisioningWorkerHealth =
  | {
      ok: true;
      required: boolean;
      url?: string;
    }
  | {
      ok: false;
      required: true;
      status: 502 | 503;
      code:
        | "PROVISIONING_WORKER_NOT_CONFIGURED"
        | "PROVISIONING_WORKER_UNHEALTHY"
        | "PROVISIONING_WORKER_UNREACHABLE";
      error: string;
    };

function readEnvValue(keys: readonly string[]): string | undefined {
  const env = getCloudAwareEnv();
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isProvisioningWorkerRequired(): boolean {
  const env = getCloudAwareEnv();
  return env.NODE_ENV === "production" || env.REQUIRE_PROVISIONING_WORKER === "true";
}

function healthUrlFor(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

export async function checkProvisioningWorkerHealth(
  timeoutMs = 3000,
): Promise<ProvisioningWorkerHealth> {
  const required = isProvisioningWorkerRequired();
  const baseUrl = readEnvValue(CONTROL_PLANE_URL_KEYS);

  if (!required) {
    return { ok: true, required: false, ...(baseUrl ? { url: baseUrl } : {}) };
  }

  if (!baseUrl) {
    return {
      ok: false,
      required: true,
      status: 503,
      code: "PROVISIONING_WORKER_NOT_CONFIGURED",
      error:
        "Agent provisioning worker is not configured. Set CONTAINER_CONTROL_PLANE_URL before accepting provisioning requests.",
    };
  }

  const headers = new Headers({ Accept: "application/json" });
  const token = readEnvValue(["CONTAINER_CONTROL_PLANE_TOKEN"]);
  if (token) headers.set("x-container-control-plane-token", token);

  try {
    const response = await fetch(healthUrlFor(baseUrl), {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return {
        ok: false,
        required: true,
        status: 503,
        code: "PROVISIONING_WORKER_UNHEALTHY",
        error: `Agent provisioning worker health check failed with HTTP ${response.status}.`,
      };
    }
    return { ok: true, required, url: baseUrl };
  } catch (error) {
    return {
      ok: false,
      required: true,
      status: 502,
      code: "PROVISIONING_WORKER_UNREACHABLE",
      error:
        error instanceof Error
          ? `Agent provisioning worker is unreachable: ${error.message}`
          : "Agent provisioning worker is unreachable.",
    };
  }
}

export function provisioningWorkerFailureBody(
  health: Extract<ProvisioningWorkerHealth, { ok: false }>,
) {
  return {
    success: false,
    code: health.code,
    error: health.error,
    retryable: true,
  };
}
