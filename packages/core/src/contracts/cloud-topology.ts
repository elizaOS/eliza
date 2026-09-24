/**
 * Derives the effective Eliza Cloud topology from a resolved config record:
 * whether the account is linked, the deployment runtime (cloud vs local), which
 * cloud services (inference/tts/media/embeddings/rpc) are routed through the
 * cloud proxy, and whether the eliza-cloud plugin should load. Reads through the
 * `first-run-options` resolvers; linkage treats a
 * `[REDACTED]` API key as unset.
 */
import {
	normalizeFirstRunProviderId,
	resolveDeploymentTargetInConfig,
	resolveLinkedAccountsInConfig,
	resolveServiceRoutingInConfig,
} from "./first-run-options.js";

export const ELIZA_CLOUD_SERVICES = [
	"inference",
	"tts",
	"media",
	"embeddings",
	"rpc",
] as const;

export type ElizaCloudService = (typeof ELIZA_CLOUD_SERVICES)[number];

export type ResolvedElizaCloudTopology = {
	linked: boolean;
	provider: "elizacloud" | null;
	runtime: "cloud" | "local";
	services: Record<ElizaCloudService, boolean>;
	/** Cloud-routed services that cannot run because no Cloud account is linked. */
	servicesUnreconciled: ElizaCloudService[];
	shouldLoadPlugin: boolean;
};

const REDACTED_SECRET = "[REDACTED]";

function asConfigRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function normalizeSecretString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.toUpperCase() === REDACTED_SECRET) {
		return undefined;
	}
	return trimmed;
}

export function isElizaCloudLinkedInConfig(
	config: Record<string, unknown> | null | undefined,
): boolean {
	const linkedAccounts = resolveLinkedAccountsInConfig(config);
	const linkedCloudAccount = linkedAccounts?.elizacloud;
	if (linkedCloudAccount?.status === "linked") {
		return true;
	}

	const cloud = asConfigRecord(config?.cloud);
	return Boolean(normalizeSecretString(cloud?.apiKey));
}

export function resolveElizaCloudTopology(
	config: Record<string, unknown> | null | undefined,
): ResolvedElizaCloudTopology {
	const deploymentTarget = resolveDeploymentTargetInConfig(config);
	const routing = resolveServiceRoutingInConfig(config);
	const provider =
		(normalizeFirstRunProviderId(routing?.llmText?.backend) === "elizacloud"
			? "elizacloud"
			: null) ??
		(deploymentTarget.provider === "elizacloud" ? "elizacloud" : null);
	const runtime = deploymentTarget.runtime === "cloud" ? "cloud" : "local";
	const resolvedServices = {
		inference: Boolean(
			routing?.llmText?.transport === "cloud-proxy" &&
				normalizeFirstRunProviderId(routing.llmText.backend) === "elizacloud",
		),
		tts: Boolean(
			routing?.tts?.transport === "cloud-proxy" &&
				normalizeFirstRunProviderId(routing.tts.backend) === "elizacloud",
		),
		media: Boolean(
			routing?.media?.transport === "cloud-proxy" &&
				normalizeFirstRunProviderId(routing.media.backend) === "elizacloud",
		),
		embeddings: Boolean(
			routing?.embeddings?.transport === "cloud-proxy" &&
				normalizeFirstRunProviderId(routing.embeddings.backend) ===
					"elizacloud",
		),
		rpc: Boolean(
			routing?.rpc?.transport === "cloud-proxy" &&
				normalizeFirstRunProviderId(routing.rpc.backend) === "elizacloud",
		),
	} satisfies Record<ElizaCloudService, boolean>;
	const cloudDeploymentSelected =
		deploymentTarget.runtime === "cloud" &&
		deploymentTarget.provider === "elizacloud";
	const linked = isElizaCloudLinkedInConfig(config);
	const servicesUnreconciled = linked
		? []
		: (Object.entries(resolvedServices) as [ElizaCloudService, boolean][])
				.filter(([, selected]) => selected)
				.map(([service]) => service);

	return {
		linked,
		provider,
		runtime,
		services: resolvedServices,
		servicesUnreconciled,
		shouldLoadPlugin:
			cloudDeploymentSelected || Object.values(resolvedServices).some(Boolean),
	};
}

/** Whether Cloud routing declares at least one service without a linked account. */
export function hasUnreconciledElizaCloudServices(
	config: Record<string, unknown> | null | undefined,
): boolean {
	return resolveElizaCloudTopology(config).servicesUnreconciled.length > 0;
}

export function isElizaCloudServiceSelectedInConfig(
	config: Record<string, unknown> | null | undefined,
	service: ElizaCloudService,
): boolean {
	return resolveElizaCloudTopology(config).services[service];
}

export function shouldLoadElizaCloudPluginInConfig(
	config: Record<string, unknown> | null | undefined,
): boolean {
	return resolveElizaCloudTopology(config).shouldLoadPlugin;
}
