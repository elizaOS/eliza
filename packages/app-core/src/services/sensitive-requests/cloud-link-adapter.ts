/**
 * Sensitive-request delivery adapter for the `cloud_authenticated_link` target:
 * resolves the paired Eliza Cloud site base URL (from runtime settings or env,
 * the default resolver gated on ELIZAOS_CLOUD_API_KEY) and builds the
 * authenticated cloud link the owner opens to satisfy the request —
 * `/sensitive-requests/<id>` for secret/oauth/private_info, and
 * `/payment/app-charge/<appId>/<id>` for payment (appId from the target or the
 * request callback). Returns a structured DeliveryResult: delivered with url +
 * expiresAt, or delivered:false with a reason when cloud is not paired or a
 * payment request is missing its appId.
 */
import type {
  DeliveryResult,
  DispatchSensitiveRequest as SensitiveRequest,
  SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { normalizeCloudSiteUrl, readAliasedEnv } from "@elizaos/shared";

export interface CloudLinkAdapterDeps {
  /**
   * Resolves the cloud site base URL (e.g. `https://www.elizacloud.ai`) when
   * the user has paired Eliza Cloud. Returns `null` when cloud is not
   * configured. Defaults to a runtime-aware resolver that consults
   * `runtime.getSetting("ELIZAOS_CLOUD_API_KEY")` /
   * `runtime.getSetting("ELIZAOS_CLOUD_BASE_URL")` with `process.env`
   * fallbacks.
   */
  resolveCloudBase?: (runtime: unknown) => string | null;
}

interface RuntimeWithSettings {
  getSetting?: (key: string) => unknown;
}

function readSetting(runtime: unknown, key: string): string | undefined {
  const candidate = (
    runtime as RuntimeWithSettings | null | undefined
  )?.getSetting?.(key);
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function defaultResolveCloudBase(runtime: unknown): string | null {
  const apiKey =
    readSetting(runtime, "ELIZAOS_CLOUD_API_KEY") ??
    readAliasedEnv("ELIZAOS_CLOUD_API_KEY");
  if (!apiKey) return null;

  const rawBase =
    readSetting(runtime, "ELIZAOS_CLOUD_BASE_URL") ??
    readAliasedEnv("ELIZAOS_CLOUD_BASE_URL");
  const normalized = normalizeCloudSiteUrl(rawBase);
  return normalized || null;
}

function readPaymentAppId(request: SensitiveRequest): string | undefined {
  const target = request.target as Record<string, unknown>;
  const targetAppId = target.appId;
  if (typeof targetAppId === "string" && targetAppId.trim()) {
    return targetAppId.trim();
  }
  const callbackAppId = (
    request.callback as Record<string, unknown> | undefined
  )?.appId;
  if (typeof callbackAppId === "string" && callbackAppId.trim()) {
    return callbackAppId.trim();
  }
  return undefined;
}

function buildUrl(
  cloudBase: string,
  request: SensitiveRequest,
): { url: string } | { error: string } {
  const id = encodeURIComponent(request.id);
  if (request.kind === "payment") {
    const appId = readPaymentAppId(request);
    if (!appId) {
      return { error: "payment request missing appId" };
    }
    return {
      url: `${cloudBase}/payment/app-charge/${encodeURIComponent(appId)}/${id}`,
    };
  }
  return { url: `${cloudBase}/sensitive-requests/${id}` };
}

export function createCloudLinkSensitiveRequestAdapter(
  deps: CloudLinkAdapterDeps = {},
): SensitiveRequestDeliveryAdapter {
  const resolveCloudBase = deps.resolveCloudBase ?? defaultResolveCloudBase;

  return {
    target: "cloud_authenticated_link",
    async deliver({ request, runtime }): Promise<DeliveryResult> {
      const cloudBase = resolveCloudBase(runtime);
      if (!cloudBase) {
        return {
          delivered: false,
          target: "cloud_authenticated_link",
          error: "cloud not paired",
        };
      }
      const built = buildUrl(cloudBase, request);
      if ("error" in built) {
        return {
          delivered: false,
          target: "cloud_authenticated_link",
          error: built.error,
        };
      }
      return {
        delivered: true,
        target: "cloud_authenticated_link",
        url: built.url,
        expiresAt: request.expiresAt,
      };
    },
  };
}

export const cloudLinkSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  createCloudLinkSensitiveRequestAdapter();
