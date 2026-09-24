/**
 * Runtime deployment-target type contracts.
 *
 * Where an Eliza runtime is deployed (local / cloud / remote) and how it
 * reaches its hosted services. Pure types only — normalization helpers
 * remain in the adjacent service-routing module.
 */

export const DEPLOYMENT_TARGET_RUNTIMES = ["local", "cloud", "remote"] as const;

export type DeploymentTargetRuntime =
	(typeof DEPLOYMENT_TARGET_RUNTIMES)[number];

export type DeploymentTargetConfig = {
	runtime: DeploymentTargetRuntime;
	provider?: "elizacloud" | "remote";
	remoteApiBase?: string;
	remoteAccessToken?: string;
};
