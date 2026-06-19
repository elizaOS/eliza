/**
 * Eliza Cloud topology type contracts.
 *
 * Describes how the local runtime sees its relationship to Eliza Cloud —
 * which services are routed there, whether the plugin should load, etc.
 * Pure types only — resolution logic lives in @elizaos/core.
 */

export const ELIZA_CLOUD_SERVICES = ['inference', 'tts', 'media', 'embeddings', 'rpc'] as const;

export type ElizaCloudService = (typeof ELIZA_CLOUD_SERVICES)[number];

export type ResolvedElizaCloudTopology = {
	linked: boolean;
	provider: 'elizacloud' | null;
	runtime: 'cloud' | 'local';
	services: Record<ElizaCloudService, boolean>;
	shouldLoadPlugin: boolean;
};
