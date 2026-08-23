/**
 * Pins the deployment-target runtime literals and their configuration type
 * contract without involving runtime services or external integrations.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
	DEPLOYMENT_TARGET_RUNTIMES,
	type DeploymentTargetConfig,
	type DeploymentTargetRuntime,
} from "./deployment-types.ts";

describe("deployment target contracts", () => {
	it("keeps the supported runtimes in canonical order", () => {
		expect(DEPLOYMENT_TARGET_RUNTIMES).toEqual(["local", "cloud", "remote"]);
	});

	it("derives the runtime union from the exported literals", () => {
		expectTypeOf<DeploymentTargetRuntime>().toEqualTypeOf<
			(typeof DEPLOYMENT_TARGET_RUNTIMES)[number]
		>();
	});

	it("keeps provider and remote connection fields optional and bounded", () => {
		expectTypeOf<DeploymentTargetConfig>().toEqualTypeOf<{
			runtime: "local" | "cloud" | "remote";
			provider?: "elizacloud" | "remote";
			remoteApiBase?: string;
			remoteAccessToken?: string;
		}>();

		const local: DeploymentTargetConfig = { runtime: "local" };
		const remote: DeploymentTargetConfig = {
			runtime: "remote",
			provider: "remote",
			remoteApiBase: "https://runtime.example.test",
			remoteAccessToken: "token",
		};

		expect(local).toEqual({ runtime: "local" });
		expect(remote.provider).toBe("remote");
	});
});
