/**
 * SensitiveRequestDeliveryAdapter factory for
 * `target === "tunnel_authenticated_link"`: routes a sensitive-request to the
 * device's active tunnel by returning `${tunnelBase}/api/sensitive-requests/<id>`.
 * The tunnel-status resolver is injectable (for tests) and defaults to the core
 * `getTunnelService`; when no tunnel is active it fails with "no active tunnel".
 * Also exports a ready-made singleton (`tunnelLinkSensitiveRequestAdapter`).
 */
import type {
  DeliveryResult,
  IAgentRuntime,
  DispatchSensitiveRequest as SensitiveRequest,
  SensitiveRequestDeliveryAdapter,
  TunnelStatus,
} from "@elizaos/core";
import { getTunnelService } from "@elizaos/core";

type TunnelLinkStatus = Pick<TunnelStatus, "active" | "url">;

export interface TunnelLinkAdapterDeps {
  /**
   * Resolves the active tunnel base URL. Mirrors the helper used by
   * the core tunnel-service contract. Returns `null` when no tunnel is active.
   */
  getTunnelStatus?: (runtime: unknown) => TunnelLinkStatus | null;
}

type RuntimeWithService = Pick<IAgentRuntime, "getService">;

function isRuntimeWithService(value: unknown): value is RuntimeWithService {
  return (
    typeof (value as { getService?: unknown } | null | undefined)
      ?.getService === "function"
  );
}

function defaultGetTunnelStatus(runtime: unknown): TunnelLinkStatus | null {
  if (!isRuntimeWithService(runtime)) return null;
  const service = getTunnelService(runtime);
  if (!service) return null;
  const status = service.getStatus?.();
  const active = Boolean(status?.active ?? service.isActive?.());
  const url =
    typeof status?.url === "string" ? status.url : (service.getUrl?.() ?? null);
  return { active, url };
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createTunnelLinkSensitiveRequestAdapter(
  deps: TunnelLinkAdapterDeps = {},
): SensitiveRequestDeliveryAdapter {
  const getTunnelStatus = deps.getTunnelStatus ?? defaultGetTunnelStatus;

  return {
    target: "tunnel_authenticated_link",
    async deliver({
      request,
      runtime,
    }: {
      request: SensitiveRequest;
      channelId?: string;
      runtime: unknown;
    }): Promise<DeliveryResult> {
      const status = getTunnelStatus(runtime);
      if (!status?.active || !status.url) {
        return {
          delivered: false,
          target: "tunnel_authenticated_link",
          error: "no active tunnel",
        };
      }
      const base = trimTrailingSlash(status.url);
      const id = encodeURIComponent(request.id);
      const url = `${base}/api/sensitive-requests/${id}`;
      return {
        delivered: true,
        target: "tunnel_authenticated_link",
        url,
        expiresAt: request.expiresAt,
      };
    },
  };
}

export const tunnelLinkSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  createTunnelLinkSensitiveRequestAdapter();
