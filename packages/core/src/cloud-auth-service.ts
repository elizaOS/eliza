/**
 * Contract and safe accessor for the cloud-auth service that a plugin registers
 * in the runtime's `ServiceType.CLOUD_AUTH` slot. `getCloudAuthService` resolves
 * that slot and duck-types the result, so core-side callers can read the current
 * API key / user / organization without importing the plugin that provides it.
 * A slot holding a service that does not implement the interface resolves to
 * null rather than throwing.
 */
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
