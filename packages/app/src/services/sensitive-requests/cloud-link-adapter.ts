/**
 * Sensitive-request delivery adapter for the `cloud_authenticated_link` target:
 * resolves the paired Eliza Cloud site base URL (from runtime settings or env,
 * the default resolver gated on ELIZAOS_CLOUD_API_KEY) and builds the
 * authenticated cloud link the owner opens to satisfy the request —
 * `/sensitive-requests/<id>` for secret/oauth/private_info, and
 * `/payment/<id>` (the hosted payment-request page) for payment. Returns a
 * structured DeliveryResult: delivered with url + expiresAt, or
 * delivered:false with a reason when cloud is not paired.
 */

import type {
  DeliveryResult,
  DispatchSensitiveRequest as SensitiveRequest,
  SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/host/protocol";
import { normalizeCloudSiteUrl } from "@elizaos/plugin-elizacloud/cloud-config/base-url";
import { captureDevCloudEnvAuthoritySnapshot } from "@elizaos/plugin-elizacloud/cloud-config/dev-cloud-env-authority";
export interface CloudLinkAdapterDeps {
  /**
   * Resolves the cloud site base URL (for example, `https://cloud.eliza.app`) when
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
  const authoritySnapshot = captureDevCloudEnvAuthoritySnapshot();
  if (authoritySnapshot) {
    if (
      authoritySnapshot.authority === "staging-default" ||
      authoritySnapshot.authority === "offline"
    ) {
      return null;
    }
    const apiKey = authoritySnapshot.values.ELIZAOS_CLOUD_API_KEY?.trim();
    const rawBase = authoritySnapshot.values.ELIZAOS_CLOUD_BASE_URL?.trim();
    if (!apiKey || !rawBase) return null;
    const normalized = normalizeCloudSiteUrl(rawBase);
    return normalized || null;
  }
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
function buildUrl(cloudBase: string, request: SensitiveRequest): string {
  const id = encodeURIComponent(request.id);
  return request.kind === "payment"
    ? `${cloudBase}/payment/${id}`
    : `${cloudBase}/sensitive-requests/${id}`;
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
      return {
        delivered: true,
        target: "cloud_authenticated_link",
        url: buildUrl(cloudBase, request),
        expiresAt: request.expiresAt,
      };
    },
  };
}
export const cloudLinkSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  createCloudLinkSensitiveRequestAdapter();
