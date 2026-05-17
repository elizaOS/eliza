/**
 * Deployment target type contracts.
 *
 * Where a Milady runtime is deployed (local / cloud / remote) and how it
 * reaches its hosted services. Pure types only — normalization helpers
 * remain in @elizaos/core.
 */

export type DeploymentTargetRuntime = 'local' | 'cloud' | 'remote';

export type DeploymentTargetConfig = {
	runtime: DeploymentTargetRuntime;
	provider?: 'elizacloud' | 'remote';
	remoteApiBase?: string;
	remoteAccessToken?: string;
};
