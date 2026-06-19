/**
 * `public_link` delivery adapter.
 *
 * Generates an unauthenticated payment URL for `kind === "payment"` with
 * `paymentContext.kind === "any_payer"`. Refuses every other shape with a
 * structured `DeliveryFailure` so the caller can fall back to a different
 * adapter (cloud authenticated link, DM, etc.).
 *
 * The adapter never makes network calls — URL construction is purely
 * declarative against the resolved cloud base URL.
 */

import {
  type DeliveryResult,
  type SensitiveRequestDeliveryAdapter,
  type SensitiveRequestWithPaymentContext,
  toRuntimeSettings,
} from "@elizaos/core";

const CLOUD_BASE_FALLBACK = "https://www.elizacloud.ai/api/v1";

/**
 * Structural subset of `IAgentRuntime` we touch for cloud base resolution.
 * Mirrors `cloud-routing.ts`'s public surface so we don't depend on the
 * concrete runtime class.
 */
interface CloudBaseRuntime {
  getSetting(
    key: string,
  ): string | boolean | number | bigint | null | undefined;
}

function isCloudBaseRuntime(value: unknown): value is CloudBaseRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getSetting?: unknown }).getSetting === "function"
  );
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveCloudBaseUrl(runtime: unknown): string {
  if (isCloudBaseRuntime(runtime)) {
    const settings = toRuntimeSettings(runtime);
    const fromSetting = settings.getSetting("ELIZAOS_CLOUD_BASE_URL");
    if (typeof fromSetting === "string" && fromSetting.trim()) {
      return stripTrailingSlashes(fromSetting.trim());
    }
  }
  const fromEnv = nonEmpty(process.env.ELIZAOS_CLOUD_BASE_URL);
  if (fromEnv) return stripTrailingSlashes(fromEnv);
  return stripTrailingSlashes(CLOUD_BASE_FALLBACK);
}

function readAppId(
  request: SensitiveRequestWithPaymentContext,
): string | undefined {
  const target = request.target as Record<string, unknown>;
  const fromTarget = target.appId;
  if (typeof fromTarget === "string" && fromTarget.trim()) {
    return fromTarget.trim();
  }
  const callback = request.callback as Record<string, unknown> | undefined;
  const fromCallback = callback?.appId;
  if (typeof fromCallback === "string" && fromCallback.trim()) {
    return fromCallback.trim();
  }
  return undefined;
}

export const publicLinkSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  {
    target: "public_link",
    async deliver({ request, runtime }): Promise<DeliveryResult> {
      const typed = request as SensitiveRequestWithPaymentContext;

      if (typed.kind !== "payment") {
        return {
          delivered: false,
          target: "public_link",
          error: "public_link only allowed for any_payer payment",
        };
      }
      if (typed.paymentContext?.kind !== "any_payer") {
        return {
          delivered: false,
          target: "public_link",
          error: "public_link only allowed for any_payer payment",
        };
      }

      const appId = readAppId(typed);
      if (!appId) {
        return {
          delivered: false,
          target: "public_link",
          error: "public_link payment request is missing appId",
        };
      }

      const cloudBase = resolveCloudBaseUrl(runtime);
      const url = `${cloudBase}/payment/app-charge/${encodeURIComponent(
        appId,
      )}/${encodeURIComponent(typed.id)}/public`;

      return {
        delivered: true,
        target: "public_link",
        url,
        expiresAt: typed.expiresAt,
      };
    },
  };
