/**
 * Authenticated Headscale API-key health gate for the provisioning control plane.
 *
 * The local `/health` endpoint proves only that Headscale is running; an expired
 * or lost admin key still makes every dedicated-agent enrollment fail with 401.
 * This probe exercises the read-only `/api/v1/user` endpoint, alerts through the
 * provisioning ops channels, and throws a typed error so startup fails before a
 * worker can advertise healthy with unusable VPN credentials.
 */

import { ElizaError } from "@elizaos/core";
import type { DaemonHealthAlert } from "./provisioning-worker-health-monitor";
import { sendProvisioningWorkerAlert } from "./provisioning-worker-health-monitor";

const DEFAULT_HEADSCALE_API_URL = "http://localhost:8081";
const DEFAULT_TIMEOUT_MS = 5_000;

export type HeadscaleApiKeyHealthCode =
  | "HEADSCALE_API_KEY_MISSING"
  | "HEADSCALE_API_KEY_REJECTED"
  | "HEADSCALE_API_UNHEALTHY";

export type HeadscaleApiKeyHealth =
  | {
      healthy: true;
      endpoint: string;
      status: number;
    }
  | {
      healthy: false;
      endpoint: string;
      code: HeadscaleApiKeyHealthCode;
      message: string;
      status?: number;
    };

export class HeadscaleApiKeyHealthError extends ElizaError {
  override readonly name = "HeadscaleApiKeyHealthError";

  constructor(health: Extract<HeadscaleApiKeyHealth, { healthy: false }>) {
    super(health.message, {
      code: health.code,
      severity: "fatal",
      context: {
        endpoint: health.endpoint,
        status: health.status,
      },
    });
  }
}

function apiUsersEndpoint(env: NodeJS.ProcessEnv): string {
  const baseUrl = (env.HEADSCALE_API_URL || DEFAULT_HEADSCALE_API_URL).replace(/\/+$/, "");
  return `${baseUrl}/api/v1/user`;
}

/**
 * Probe the authenticated read-only endpoint used by provisioning operations.
 * Expected auth and availability failures become explicit unhealthy states so
 * the monitor can alert with a stable code without exposing the bearer token.
 */
export async function checkHeadscaleApiKeyHealth(
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<HeadscaleApiKeyHealth> {
  const env = deps.env ?? process.env;
  const endpoint = apiUsersEndpoint(env);
  const apiKey = env.HEADSCALE_API_KEY?.trim();

  if (!apiKey) {
    return {
      healthy: false,
      endpoint,
      code: "HEADSCALE_API_KEY_MISSING",
      message:
        "HEADSCALE_API_KEY is missing; dedicated-agent VPN enrollment cannot authenticate. " +
        "Rotate a key on the control-plane host and re-arm the provisioning worker.",
    };
  }

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // error-policy:J7 this diagnostic failure is converted to a paged unhealthy state below.
    const reason = error instanceof Error ? error.message : String(error);
    return {
      healthy: false,
      endpoint,
      code: "HEADSCALE_API_UNHEALTHY",
      message: `Authenticated Headscale health probe failed: ${reason}`,
    };
  }

  if (response.ok) {
    return { healthy: true, endpoint, status: response.status };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      healthy: false,
      endpoint,
      status: response.status,
      code: "HEADSCALE_API_KEY_REJECTED",
      message:
        `Headscale rejected HEADSCALE_API_KEY with HTTP ${response.status}; the key is expired, revoked, or belongs to a different server. ` +
        "Rotate it on the control-plane host and re-arm the provisioning worker.",
    };
  }

  return {
    healthy: false,
    endpoint,
    status: response.status,
    code: "HEADSCALE_API_UNHEALTHY",
    message: `Authenticated Headscale health probe returned HTTP ${response.status}.`,
  };
}

/**
 * Alert and fail fast when the authenticated Headscale probe is unhealthy.
 * PagerDuty deduplicates this failure domain independently from daemon-heartbeat
 * and backup-restorability incidents.
 */
export async function assertHeadscaleApiKeyHealthy(
  deps: {
    check?: () => Promise<HeadscaleApiKeyHealth>;
    alert?: (alert: DaemonHealthAlert) => void | Promise<void>;
  } = {},
): Promise<HeadscaleApiKeyHealth> {
  const health = await (deps.check ?? checkHeadscaleApiKeyHealth)();
  if (health.healthy) return health;

  await (deps.alert ?? sendProvisioningWorkerAlert)({
    title: "Headscale API key is unhealthy",
    message: health.message,
    dedupKey: "headscale-api-key-unhealthy",
    details: {
      code: health.code,
      endpoint: health.endpoint,
      status: health.status,
    },
  });
  throw new HeadscaleApiKeyHealthError(health);
}
