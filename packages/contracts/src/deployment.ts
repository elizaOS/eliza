/**
 * Deployment target type contracts.
 *
 * Where a Eliza runtime is deployed (local / cloud / remote) and how it
 * reaches its hosted services. Pure types only — normalization helpers
 * remain in @elizaos/core.
 */

export const DEPLOYMENT_TARGET_RUNTIMES = ['local', 'cloud', 'remote'] as const;

export type DeploymentTargetRuntime = (typeof DEPLOYMENT_TARGET_RUNTIMES)[number];

export type DeploymentTargetConfig = {
	runtime: DeploymentTargetRuntime;
	provider?: 'elizacloud' | 'remote';
	remoteApiBase?: string;
	remoteAccessToken?: string;
};
