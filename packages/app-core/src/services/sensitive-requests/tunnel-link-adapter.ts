import type {
  DeliveryResult,
  DispatchSensitiveRequest as SensitiveRequest,
  SensitiveRequestDeliveryAdapter,
} from "@elizaos/core";

export interface TunnelStatus {
  active: boolean;
  url?: string | null;
}

export interface TunnelLinkAdapterDeps {
  /**
   * Resolves the active tunnel base URL. Mirrors the helper used by
   * `packages/app-core/src/api/sensitive-request-routes.ts` which queries
   * `runtime.getService("tunnel")` for `getStatus()` / `isActive()` /
   * `getUrl()`. Returns `null` when no tunnel is active.
   */
  getTunnelStatus?: (runtime: unknown) => TunnelStatus | null;
}

interface TunnelService {
  getStatus?: () => { active?: boolean; url?: string | null } | undefined;
  isActive?: () => boolean;
  getUrl?: () => string | null;
}

interface RuntimeWithService {
  getService?: (name: string) => unknown;
}

function defaultGetTunnelStatus(runtime: unknown): TunnelStatus | null {
  const service = (
    runtime as RuntimeWithService | null | undefined
  )?.getService?.("tunnel") as TunnelService | null | undefined;
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
