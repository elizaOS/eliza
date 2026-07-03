import { describe, expect, test } from "vitest";
import {
	CLOUD_AUTH_SERVICE_TYPE,
	getCloudAuthService,
} from "./cloud-auth-service";

type CloudAuthRuntime = Parameters<typeof getCloudAuthService>[0];

function runtimeWithCloudAuth(service: unknown): CloudAuthRuntime {
	return {
		getService: (serviceType: string) =>
			serviceType === CLOUD_AUTH_SERVICE_TYPE ? service : null,
	} as unknown as CloudAuthRuntime;
}

describe("getCloudAuthService", () => {
	test("resolves a cloud auth service through the core service slot", () => {
		const cloudAuth = {
			isAuthenticated: () => true,
			getCredentials: () => ({
				apiKey: "eliza_test",
				userId: "user-1",
			}),
			getApiKey: () => "eliza_test",
			getUserId: () => "user-1",
			getOrganizationId: () => "org-1",
		};

		expect(
			getCloudAuthService(runtimeWithCloudAuth(cloudAuth))?.getUserId(),
		).toBe("user-1");
	});

	test("returns null when the registered service does not implement cloud auth", () => {
		expect(getCloudAuthService(runtimeWithCloudAuth({}))).toBeNull();
	});
});
