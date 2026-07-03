import type { IAgentRuntime } from "./types/runtime";
import type { Service } from "./types/service";
import { ServiceType } from "./types/service";

type CloudAuthRuntime = Pick<IAgentRuntime, "getService">;

export const CLOUD_AUTH_SERVICE_TYPE = ServiceType.CLOUD_AUTH;

export interface CloudAuthCredentials {
	apiKey: string;
	userId?: string;
	organizationId?: string;
	authenticatedAt?: number;
}

export interface ICloudAuthService {
	isAuthenticated(): boolean;
	getCredentials(): CloudAuthCredentials | null;
	getApiKey(): string | undefined;
	getUserId(): string | undefined;
	getOrganizationId(): string | undefined;
}

export function getCloudAuthService(
	runtime: CloudAuthRuntime,
): (Service & ICloudAuthService) | null {
	const service = runtime.getService(CLOUD_AUTH_SERVICE_TYPE);
	if (!service) return null;
	if (typeof (service as Partial<ICloudAuthService>).getUserId !== "function") {
		return null;
	}
	if (
		typeof (service as Partial<ICloudAuthService>).isAuthenticated !==
		"function"
	) {
		return null;
	}
	return service as Service & ICloudAuthService;
}
