import type { IAgentRuntime } from "./types/runtime";
import type { Service } from "./types/service";
import { ServiceType } from "./types/service";

type TunnelRuntime = Pick<IAgentRuntime, "getService">;

export type TunnelProvider = "tailscale" | "headscale" | "ngrok";

export interface TunnelStatus {
	active: boolean;
	url: string | null;
	port: number | null;
	startedAt: Date | null;
	provider: TunnelProvider;
	/** Optional human label distinguishing backend variants, e.g. "local-cli". */
	backend?: string;
}

export interface ITunnelService {
	startTunnel(port?: number): Promise<string | undefined>;
	stopTunnel(): Promise<void>;
	getUrl(): string | null;
	isActive(): boolean;
	getStatus(): TunnelStatus;
}

export function getTunnelService(
	runtime: TunnelRuntime,
): ITunnelService | null {
	const service = runtime.getService(ServiceType.TUNNEL);
	if (!service) return null;
	if (typeof (service as Partial<ITunnelService>).startTunnel !== "function") {
		return null;
	}
	return service as Service & ITunnelService;
}

export function tunnelSlotIsFree(runtime: TunnelRuntime): boolean {
	return runtime.getService(ServiceType.TUNNEL) === null;
}
