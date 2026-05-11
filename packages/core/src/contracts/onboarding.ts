/**
 * Shared onboarding contracts.
 */

import { isTruthyEnvValue } from "../env-utils.js";
import type {
	DeploymentTargetConfig,
	LinkedAccountFlagsConfig,
	LinkedAccountProviderId,
	ServiceRouteConfig,
	ServiceRoutingConfig,
} from "./service-routing.js";
import {
	normalizeDeploymentTargetConfig,
	normalizeLinkedAccountFlagsConfig,
	normalizeServiceRoutingConfig,
} from "./service-routing.js";

export const CHARACTER_LANGUAGES = [
	"en",
	"zh-CN",
	"ko",
	"es",
	"pt",
	"vi",
	"tl",
] as const;

export type CharacterLanguage = (typeof CHARACTER_LANGUAGES)[number];

export interface StylePreset {
	id: string;
	name: string;
	avatarIndex: number;
	voicePresetId: string;
	greetingAnimation: string;
	catchphrase: string;
	hint: string;
	bio: string[];
	system: string;
	adjectives: string[];
	style: {
		all: string[];
		chat: string[];
		post: string[];
	};
	topics: string[];
	postExamples: string[];
	postExamples_zhCN?: string[];
	messageExamples: Array<
		Array<{
			user: string;
			content: { text: string };
		}>
	>;
}

export type OnboardingProviderFamily =
	| "anthropic"
	| "deepseek"
	| "elizacloud"
	| "gemini"
	| "grok"
	| "groq"
	| "mistral"
	| "moonshot"
	| "ollama"
	| "openai"
	| "openrouter"
	| "together"
	| "zai"
	| (string & {});

export type OnboardingProviderId =
	| "anthropic"
	| "anthropic-subscription"
	| "deepseek"
	| "deepseek-coding-subscription"
	| "elizacloud"
	| "gemini"
	| "gemini-subscription"
	| "grok"
	| "groq"
	| "kimi-coding-subscription"
	| "mistral"
	| "moonshot"
	| "ollama"
	| "openai"
	| "openai-subscription"
	| "openrouter"
	| "together"
	| "zai"
	| "zai-coding-subscription"
	| (string & {});

export type OnboardingProviderAuthMode =
	| "api-key"
	| "cloud"
	| "credentials"
	| "local"
	| "subscription"
	| (string & {});

export type OnboardingProviderGroup =
	| "cloud"
	| "local"
	| "subscription"
	| (string & {});

export interface ProviderOption {
	id: OnboardingProviderId;
	name: string;
	envKey: string | null;
	pluginName: string;
	keyPrefix: string | null;
	description: string;
	family: OnboardingProviderFamily;
	authMode: OnboardingProviderAuthMode;
	group: OnboardingProviderGroup;
	order: number;
	recommended?: boolean;
	labelKey?: string;
	storedProvider?: string;
	supportsPrimaryModelOverride?: boolean;
}

export interface CloudProviderOption {
	id: "elizacloud";
	name: string;
	description: string;
}

export interface ModelOption {
	id: string;
	name: string;
	provider: string;
	description: string;
	recommended?: boolean;
	free?: boolean;
}

export interface OpenRouterModelOption {
	id: string;
	name: string;
	description: string;
}

export interface MessageExampleContent {
	text: string;
	actions?: string[];
}

export interface MessageExample {
	user: string;
	content: MessageExampleContent;
}

export interface OnboardingConnectorConfig {
	enabled?: boolean;
	botToken?: string;
	token?: string;
	apiKey?: string;
	[key: string]:
		| string
		| boolean
		| number
		| string[]
		| Record<string, unknown>
		| undefined;
}

export interface RpcProviderOption {
	id: string;
	label: string;
	envKey?: string | null;
	requiresKey?: boolean;
}

export interface InventoryProviderOption {
	id: string;
	name: string;
	description: string;
	rpcProviders: RpcProviderOption[];
}

export type SubscriptionProviderSelectionId =
	| "anthropic-subscription"
	| "openai-subscription"
	| "gemini-subscription"
	| "zai-coding-subscription"
	| "kimi-coding-subscription"
	| "deepseek-coding-subscription";

export type StoredSubscriptionProviderId =
	| "anthropic-subscription"
	| "openai-codex"
	| "gemini-cli"
	| "zai-coding"
	| "kimi-coding"
	| "deepseek-coding";

export const SUBSCRIPTION_PROVIDER_SELECTIONS = [
	{
		id: "anthropic-subscription",
		storedProvider: "anthropic-subscription",
		family: "anthropic",
		labelKey: "providerswitcher.claudeSubscription",
	},
	{
		id: "openai-subscription",
		storedProvider: "openai-codex",
		family: "openai",
		labelKey: "providerswitcher.chatgptSubscription",
	},
	{
		id: "gemini-subscription",
		storedProvider: "gemini-cli",
		family: "gemini",
		labelKey: "providerswitcher.geminiSubscription",
	},
	{
		id: "zai-coding-subscription",
		storedProvider: "zai-coding",
		family: "zai",
		labelKey: "providerswitcher.zaiCodingPlan",
	},
	{
		id: "kimi-coding-subscription",
		storedProvider: "kimi-coding",
		family: "moonshot",
		labelKey: "providerswitcher.kimiCodingPlan",
	},
	{
		id: "deepseek-coding-subscription",
		storedProvider: "deepseek-coding",
		family: "deepseek",
		labelKey: "providerswitcher.deepseekCodingPlan",
	},
] as const satisfies ReadonlyArray<{
	id: SubscriptionProviderSelectionId;
	storedProvider: StoredSubscriptionProviderId;
	family: "anthropic" | "openai" | "gemini" | "zai" | "moonshot" | "deepseek";
	labelKey: string;
}>;

export const ONBOARDING_PROVIDER_CATALOG = [
	{
		id: "elizacloud",
		name: "Eliza Cloud",
		envKey: null,
		pluginName: "@elizaos/plugin-elizacloud",
		keyPrefix: null,
		description: "Managed hosting for Eliza agents and bundled infrastructure.",
		family: "elizacloud",
		authMode: "cloud",
		group: "cloud",
		order: 10,
		recommended: true,
	},
	{
		id: "anthropic-subscription",
		name: "Claude Subscription",
		envKey: null,
		pluginName: "@elizaos/plugin-anthropic",
		keyPrefix: null,
		description:
			"Powers task agents via Claude Code CLI. For the main agent, use Eliza Cloud or a direct API key.",
		family: "anthropic",
		authMode: "subscription",
		group: "subscription",
		order: 20,
		recommended: true,
		labelKey: "providerswitcher.claudeSubscription",
		storedProvider: "anthropic-subscription",
	},
	{
		id: "openai-subscription",
		name: "ChatGPT Subscription",
		envKey: null,
		pluginName: "@elizaos/plugin-openai",
		keyPrefix: null,
		description:
			"Powers Codex-backed coding agents through the official Codex surface.",
		family: "openai",
		authMode: "subscription",
		group: "subscription",
		order: 30,
		recommended: true,
		labelKey: "providerswitcher.chatgptSubscription",
		storedProvider: "openai-codex",
	},
	{
		id: "gemini-subscription",
		name: "Gemini CLI Subscription",
		envKey: null,
		pluginName: "@elizaos/plugin-google-genai",
		keyPrefix: null,
		description:
			"Powers task agents through the authenticated Gemini CLI. No Gemini subscription token is imported into API env vars.",
		family: "gemini",
		authMode: "subscription",
		group: "subscription",
		order: 35,
		labelKey: "providerswitcher.geminiSubscription",
		storedProvider: "gemini-cli",
	},
	{
		id: "zai-coding-subscription",
		name: "z.ai Coding Plan",
		envKey: null,
		pluginName: "@elizaos/plugin-zai",
		keyPrefix: null,
		description:
			"Stores z.ai Coding Plan credentials for the dedicated coding endpoint only, not the general z.ai API key path.",
		family: "zai",
		authMode: "subscription",
		group: "subscription",
		order: 36,
		labelKey: "providerswitcher.zaiCodingPlan",
		storedProvider: "zai-coding",
	},
	{
		id: "kimi-coding-subscription",
		name: "Kimi Code",
		envKey: null,
		pluginName: "@elizaos/plugin-openai",
		keyPrefix: null,
		description:
			"Stores Kimi Code credentials for Kimi's coding endpoint only, not the Moonshot general API key path.",
		family: "moonshot",
		authMode: "subscription",
		group: "subscription",
		order: 37,
		labelKey: "providerswitcher.kimiCodingPlan",
		storedProvider: "kimi-coding",
	},
	{
		id: "deepseek-coding-subscription",
		name: "DeepSeek Coding Plan",
		envKey: null,
		pluginName: "@elizaos/plugin-deepseek",
		keyPrefix: null,
		description:
			"Unavailable until DeepSeek exposes a first-party coding subscription surface that can be integrated without API-key substitution.",
		family: "deepseek",
		authMode: "subscription",
		group: "subscription",
		order: 38,
		labelKey: "providerswitcher.deepseekCodingPlan",
		storedProvider: "deepseek-coding",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		envKey: "ANTHROPIC_API_KEY",
		pluginName: "@elizaos/plugin-anthropic",
		keyPrefix: "sk-ant-",
		description: "Claude models via API key.",
		family: "anthropic",
		authMode: "api-key",
		group: "local",
		order: 50,
	},
	{
		id: "openai",
		name: "OpenAI",
		envKey: "OPENAI_API_KEY",
		pluginName: "@elizaos/plugin-openai",
		keyPrefix: "sk-",
		description: "GPT models via API key.",
		family: "openai",
		authMode: "api-key",
		group: "local",
		order: 60,
	},
	{
		id: "openrouter",
		name: "OpenRouter",
		envKey: "OPENROUTER_API_KEY",
		pluginName: "@elizaos/plugin-openrouter",
		keyPrefix: "sk-or-",
		description: "Access multiple models via one API key.",
		family: "openrouter",
		authMode: "api-key",
		group: "local",
		order: 70,
		supportsPrimaryModelOverride: true,
	},
	{
		id: "gemini",
		name: "Gemini",
		envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
		pluginName: "@elizaos/plugin-google-genai",
		keyPrefix: null,
		description: "Google's Gemini models.",
		family: "gemini",
		authMode: "api-key",
		group: "local",
		order: 80,
	},
	{
		id: "grok",
		name: "xAI (Grok)",
		envKey: "XAI_API_KEY",
		pluginName: "@elizaos/plugin-xai",
		keyPrefix: "xai-",
		description: "xAI's Grok models.",
		family: "grok",
		authMode: "api-key",
		group: "local",
		order: 90,
	},
	{
		id: "groq",
		name: "Groq",
		envKey: "GROQ_API_KEY",
		pluginName: "@elizaos/plugin-groq",
		keyPrefix: "gsk_",
		description: "Fast inference.",
		family: "groq",
		authMode: "api-key",
		group: "local",
		order: 100,
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		envKey: "DEEPSEEK_API_KEY",
		pluginName: "@elizaos/plugin-deepseek",
		keyPrefix: "sk-",
		description: "DeepSeek models.",
		family: "deepseek",
		authMode: "api-key",
		group: "local",
		order: 110,
	},
	{
		id: "mistral",
		name: "Mistral",
		envKey: "MISTRAL_API_KEY",
		pluginName: "@elizaos/plugin-mistral",
		keyPrefix: null,
		description: "Mistral AI models.",
		family: "mistral",
		authMode: "api-key",
		group: "local",
		order: 120,
	},
	{
		id: "together",
		name: "Together AI",
		envKey: "TOGETHER_API_KEY",
		pluginName: "@elizaos/plugin-together",
		keyPrefix: null,
		description: "Open-source model hosting.",
		family: "together",
		authMode: "api-key",
		group: "local",
		order: 130,
	},
	{
		id: "ollama",
		name: "Ollama",
		envKey: null,
		pluginName: "@elizaos/plugin-ollama",
		keyPrefix: null,
		description: "Local models, no API key needed.",
		family: "ollama",
		authMode: "local",
		group: "local",
		order: 140,
	},
	{
		id: "zai",
		name: "z.ai",
		envKey: "ZAI_API_KEY",
		pluginName: "@elizaos/plugin-zai",
		keyPrefix: null,
		description: "GLM models via z.ai Coding Plan.",
		family: "zai",
		authMode: "api-key",
		group: "local",
		order: 150,
	},
	{
		id: "moonshot",
		name: "Kimi / Moonshot",
		envKey: "MOONSHOT_API_KEY",
		pluginName: "@elizaos/plugin-openai",
		keyPrefix: "sk-",
		description: "Kimi models via Moonshot's OpenAI-compatible API.",
		family: "moonshot",
		authMode: "api-key",
		group: "local",
		order: 160,
		supportsPrimaryModelOverride: true,
	},
] as const satisfies ReadonlyArray<ProviderOption>;

export const DIRECT_ACCOUNT_PROVIDER_BY_ONBOARDING_PROVIDER = {
	anthropic: "anthropic-api",
	openai: "openai-api",
	deepseek: "deepseek-api",
	zai: "zai-api",
	moonshot: "moonshot-api",
} as const satisfies Partial<
	Record<OnboardingProviderId, LinkedAccountProviderId>
>;

export const ONBOARDING_CLOUD_PROVIDER_OPTIONS = [
	{
		id: "elizacloud",
		name: "Eliza Cloud",
		description:
			"Managed cloud infrastructure. Wallets, LLMs, and RPCs included.",
	},
] as const satisfies ReadonlyArray<CloudProviderOption>;

export type OnboardingLocalProviderId = Exclude<
	OnboardingProviderId,
	"elizacloud"
>;

interface OnboardingCloudModelPreferences {
	nanoModel?: string;
	smallModel?: string;
	mediumModel?: string;
	largeModel?: string;
	megaModel?: string;
	responseHandlerModel?: string;
	shouldRespondModel?: string;
	actionPlannerModel?: string;
	plannerModel?: string;
	responseModel?: string;
	mediaDescriptionModel?: string;
}

function pickOnboardingCloudModelPreferences(
	value: OnboardingCloudModelPreferences,
): OnboardingCloudModelPreferences {
	return {
		...(value.nanoModel ? { nanoModel: value.nanoModel } : {}),
		...(value.smallModel ? { smallModel: value.smallModel } : {}),
		...(value.mediumModel ? { mediumModel: value.mediumModel } : {}),
		...(value.largeModel ? { largeModel: value.largeModel } : {}),
		...(value.megaModel ? { megaModel: value.megaModel } : {}),
		...(value.responseHandlerModel
			? { responseHandlerModel: value.responseHandlerModel }
			: {}),
		...(value.shouldRespondModel
			? { shouldRespondModel: value.shouldRespondModel }
			: {}),
		...(value.actionPlannerModel
			? { actionPlannerModel: value.actionPlannerModel }
			: {}),
		...(value.plannerModel ? { plannerModel: value.plannerModel } : {}),
		...(value.responseModel ? { responseModel: value.responseModel } : {}),
		...(value.mediaDescriptionModel
			? { mediaDescriptionModel: value.mediaDescriptionModel }
			: {}),
	};
}

function readOnboardingCloudModelPreferences(
	source: Record<string, unknown> | null | undefined,
): OnboardingCloudModelPreferences {
	if (!source) {
		return {};
	}

	return pickOnboardingCloudModelPreferences({
		nanoModel: readConfigString(source, "nanoModel"),
		smallModel: readConfigString(source, "smallModel"),
		mediumModel: readConfigString(source, "mediumModel"),
		largeModel: readConfigString(source, "largeModel"),
		megaModel: readConfigString(source, "megaModel"),
		responseHandlerModel: readConfigString(source, "responseHandlerModel"),
		shouldRespondModel: readConfigString(source, "shouldRespondModel"),
		actionPlannerModel: readConfigString(source, "actionPlannerModel"),
		plannerModel: readConfigString(source, "plannerModel"),
		responseModel: readConfigString(source, "responseModel"),
		mediaDescriptionModel: readConfigString(source, "mediaDescriptionModel"),
	});
}

export interface OnboardingCloudManagedConnection
	extends OnboardingCloudModelPreferences {
	kind: "cloud-managed";
	cloudProvider: "elizacloud";
	apiKey?: string;
}

export interface OnboardingLocalProviderConnection {
	kind: "local-provider";
	provider: OnboardingLocalProviderId;
	apiKey?: string;
	primaryModel?: string;
}

export interface OnboardingRemoteProviderConnection {
	kind: "remote-provider";
	remoteApiBase: string;
	remoteAccessToken?: string;
	provider?: OnboardingLocalProviderId;
	apiKey?: string;
	primaryModel?: string;
}

export type OnboardingConnection =
	| OnboardingCloudManagedConnection
	| OnboardingLocalProviderConnection
	| OnboardingRemoteProviderConnection;

export interface OnboardingOptions {
	names: string[];
	styles: StylePreset[];
	providers: ProviderOption[];
	cloudProviders: CloudProviderOption[];
	models: {
		nano?: ModelOption[];
		small?: ModelOption[];
		medium?: ModelOption[];
		large?: ModelOption[];
		mega?: ModelOption[];
	};
	openrouterModels?: OpenRouterModelOption[];
	inventoryProviders: InventoryProviderOption[];
	sharedStyleRules: string;
	githubOAuthAvailable?: boolean;
}

export interface OnboardingCredentialInputs {
	llmApiKey?: string;
	cloudApiKey?: string;
}

export interface OnboardingLlmPersistenceSelection
	extends OnboardingCloudModelPreferences {
	backend: OnboardingProviderId;
	transport: "direct" | "remote" | "cloud-proxy";
	apiKey?: string;
	primaryModel?: string;
	remoteApiBase?: string;
	remoteAccessToken?: string;
}
export type SubscriptionCredentialSource =
	| "app"
	| "claude-code-cli"
	| "setup-token"
	| "codex-cli"
	| "gemini-cli"
	| "coding-plan-key"
	| "unavailable"
	| null;

export interface SubscriptionProviderStatus {
	provider: string;
	/**
	 * Stable per-account ID. `"default"` for legacy single-account
	 * installs; CLI/setup-token-derived rows use synthetic IDs like
	 * `"claude-code-cli"`, `"codex-cli"`, `"setup-token"`.
	 */
	accountId: string;
	/** User-facing label for this account. */
	label: string;
	configured: boolean;
	valid: boolean;
	expiresAt: number | null;
	source: SubscriptionCredentialSource;
	available?: boolean;
	availabilityReason?: string;
	allowedClient?: string;
	loginHint?: string;
	billingMode?: "subscription-coding-plan" | "subscription-coding-cli";
}

export interface SubscriptionStatusResponse {
	providers: SubscriptionProviderStatus[];
}

const ONBOARDING_PROVIDER_ALIASES: Record<string, OnboardingProviderId> = {
	"openai-codex": "openai-subscription",
	"openai-subscription": "openai-subscription",
	"anthropic-subscription": "anthropic-subscription",
	"gemini-cli": "gemini-subscription",
	"gemini-subscription": "gemini-subscription",
	"google-subscription": "gemini-subscription",
	"zai-coding": "zai-coding-subscription",
	"z.ai-coding": "zai-coding-subscription",
	"zai-coding-subscription": "zai-coding-subscription",
	"kimi-coding": "kimi-coding-subscription",
	"kimi-code": "kimi-coding-subscription",
	"kimi-coding-subscription": "kimi-coding-subscription",
	"deepseek-coding": "deepseek-coding-subscription",
	"deepseek-coding-subscription": "deepseek-coding-subscription",
	google: "gemini",
	"google-genai": "gemini",
	gemini: "gemini",
	xai: "grok",
	grok: "grok",
	"together-ai": "together",
	together: "together",
	"z.ai": "zai",
	zai: "zai",
	kimi: "moonshot",
	moonshot: "moonshot",
	moonshotai: "moonshot",
	"moonshot-ai": "moonshot",
};

export function isSubscriptionProviderSelectionId(
	value: unknown,
): value is SubscriptionProviderSelectionId {
	return SUBSCRIPTION_PROVIDER_SELECTIONS.some(
		(provider) => provider.id === value,
	);
}

export function normalizeSubscriptionProviderSelectionId(
	value: unknown,
): SubscriptionProviderSelectionId | null {
	const normalized = normalizeOnboardingProviderId(value);
	return isSubscriptionProviderSelectionId(normalized) ? normalized : null;
}

export function getStoredSubscriptionProvider(
	selectionId: SubscriptionProviderSelectionId,
): StoredSubscriptionProviderId {
	return (
		SUBSCRIPTION_PROVIDER_SELECTIONS.find(
			(provider) => provider.id === selectionId,
		)?.storedProvider ?? "anthropic-subscription"
	);
}

export function getSubscriptionProviderFamily(
	selectionId: SubscriptionProviderSelectionId,
): "anthropic" | "openai" | "gemini" | "zai" | "moonshot" | "deepseek" {
	return (
		SUBSCRIPTION_PROVIDER_SELECTIONS.find(
			(provider) => provider.id === selectionId,
		)?.family ?? "anthropic"
	);
}

export function requiresAdditionalRuntimeProvider(
	providerId: unknown,
): boolean {
	const selection = normalizeSubscriptionProviderSelectionId(providerId);
	return Boolean(selection && selection !== "openai-subscription");
}

export function normalizeOnboardingProviderId(
	value: unknown,
): OnboardingProviderId | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;

	const candidates = Array.from(
		new Set([
			trimmed,
			trimmed.replace(/^@[^/]+\//, ""),
			trimmed.replace(/^@[^/]+\//, "").replace(/^plugin-/, ""),
		]),
	);

	for (const candidate of candidates) {
		const directMatch = ONBOARDING_PROVIDER_CATALOG.find(
			(provider) => provider.id === candidate,
		);
		if (directMatch) {
			return directMatch.id;
		}

		const alias = ONBOARDING_PROVIDER_ALIASES[candidate];
		if (alias) {
			return alias;
		}
	}

	for (const candidate of candidates) {
		const pluginMatches = ONBOARDING_PROVIDER_CATALOG.filter(
			(provider) => provider.pluginName.toLowerCase() === candidate,
		);
		if (pluginMatches.length === 0) {
			continue;
		}

		// Some plugin packages back both subscription and API-key flows.
		// Prefer the concrete API-key provider unless the caller explicitly
		// passed a subscription id/alias above.
		const preferredMatch =
			pluginMatches.find((provider) => provider.authMode === "api-key") ??
			pluginMatches[0];
		if (!preferredMatch) {
			continue;
		}
		return preferredMatch.id;
	}

	return null;
}

export function getOnboardingProviderOption(
	providerId: unknown,
): ProviderOption | null {
	const normalized = normalizeOnboardingProviderId(providerId);
	if (!normalized) return null;
	return (
		ONBOARDING_PROVIDER_CATALOG.find(
			(provider) => provider.id === normalized,
		) ?? null
	);
}

export function getOnboardingProviderFamily(
	providerId: unknown,
): OnboardingProviderFamily | null {
	return getOnboardingProviderOption(providerId)?.family ?? null;
}

export function getStoredOnboardingProviderId(
	providerId: unknown,
): string | null {
	const provider = getOnboardingProviderOption(providerId);
	if (!provider) return null;
	return provider.storedProvider ?? provider.id;
}

export function getDirectAccountProviderForOnboardingProvider(
	providerId: unknown,
): LinkedAccountProviderId | null {
	const normalized = normalizeOnboardingProviderId(providerId);
	if (!normalized) return null;
	if (!(normalized in DIRECT_ACCOUNT_PROVIDER_BY_ONBOARDING_PROVIDER)) {
		return null;
	}
	return DIRECT_ACCOUNT_PROVIDER_BY_ONBOARDING_PROVIDER[
		normalized as keyof typeof DIRECT_ACCOUNT_PROVIDER_BY_ONBOARDING_PROVIDER
	];
}

export function sortOnboardingProviders(
	providers: readonly ProviderOption[],
): ProviderOption[] {
	return [...providers].sort((left, right) => {
		const recommendedDelta =
			Number(Boolean(right.recommended)) - Number(Boolean(left.recommended));
		if (recommendedDelta !== 0) {
			return recommendedDelta;
		}
		return left.order - right.order;
	});
}

export function isCloudManagedConnection(
	connection: OnboardingConnection | null | undefined,
): connection is OnboardingCloudManagedConnection {
	return connection?.kind === "cloud-managed";
}

export function isRemoteProviderConnection(
	connection: OnboardingConnection | null | undefined,
): connection is OnboardingRemoteProviderConnection {
	return connection?.kind === "remote-provider";
}

export function isLocalProviderConnection(
	connection: OnboardingConnection | null | undefined,
): connection is OnboardingLocalProviderConnection {
	return connection?.kind === "local-provider";
}

export function isOnboardingConnectionComplete(
	connection: OnboardingConnection | null | undefined,
): boolean {
	if (isLocalProviderConnection(connection)) {
		return true;
	}

	if (isRemoteProviderConnection(connection)) {
		return Boolean(connection.remoteApiBase.trim());
	}

	if (isCloudManagedConnection(connection)) {
		// Cloud OAuth sessions have no apiKey — inference access is provided by
		// the cloud session token. The connection is complete when models are
		// selected, regardless of whether an explicit API key is present.
		return Boolean(
			connection.smallModel?.trim() && connection.largeModel?.trim(),
		);
	}

	return false;
}

const REDACTED_SECRET = "[REDACTED]";
function asConfigRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readConfigString(
	source: Record<string, unknown> | null | undefined,
	key: string,
): string | undefined {
	const value = source?.[key];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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

function readOnboardingEnvContainer(
	config: Record<string, unknown> | null | undefined,
): {
	env: Record<string, unknown> | null;
	vars: Record<string, unknown> | null;
} {
	const env = asConfigRecord(config?.env);
	return {
		env,
		vars: asConfigRecord(env?.vars),
	};
}

export function readOnboardingEnvString(
	config: Record<string, unknown> | null | undefined,
	key: string,
): string | undefined {
	const { env, vars } = readOnboardingEnvContainer(config);
	return readConfigString(vars, key) ?? readConfigString(env, key);
}

export function readOnboardingEnvSecret(
	config: Record<string, unknown> | null | undefined,
	key: string,
): string | undefined {
	return normalizeSecretString(readOnboardingEnvString(config, key));
}

/** Alias to keep call-sites unchanged. */
const _isTruthyEnvFlag = isTruthyEnvValue;

export function getOnboardingProviderSignalEnvKeys(
	providerId: OnboardingLocalProviderId,
): string[] {
	if (providerId === "ollama") {
		return ["OLLAMA_BASE_URL"];
	}
	if (providerId === "zai") {
		return ["ZAI_API_KEY", "Z_AI_API_KEY"];
	}

	const provider = getOnboardingProviderOption(providerId);
	return provider?.envKey ? [provider.envKey] : [];
}

function readOnboardingProviderApiKey(
	config: Record<string, unknown> | null | undefined,
	providerId: OnboardingLocalProviderId | null | undefined,
): string | undefined {
	if (!providerId) {
		return undefined;
	}
	const provider = getOnboardingProviderOption(providerId);
	if (provider?.envKey == null) {
		return undefined;
	}
	const canonical = readOnboardingEnvSecret(config, provider.envKey);
	if (canonical || providerId !== "zai") {
		return canonical;
	}
	return readOnboardingEnvSecret(config, "Z_AI_API_KEY");
}

function readPrimaryModelFromConfig(
	config: Record<string, unknown> | null | undefined,
): string | undefined {
	const agents = asConfigRecord(config?.agents);
	const defaults = asConfigRecord(agents?.defaults);
	const model = asConfigRecord(defaults?.model);
	return readConfigString(model, "primary");
}

export function hasExplicitCanonicalRuntimeConfig(
	config: Record<string, unknown> | null | undefined,
): boolean {
	const root = asConfigRecord(config);
	return Boolean(
		root &&
			(Object.hasOwn(root, "deploymentTarget") ||
				Object.hasOwn(root, "linkedAccounts") ||
				Object.hasOwn(root, "serviceRouting")),
	);
}

function buildElizaCloudTextRoute(args: {
	nanoModel?: string;
	smallModel?: string;
	mediumModel?: string;
	largeModel?: string;
	megaModel?: string;
	responseHandlerModel?: string;
	shouldRespondModel?: string;
	actionPlannerModel?: string;
	plannerModel?: string;
	responseModel?: string;
	mediaDescriptionModel?: string;
}): ServiceRouteConfig {
	return {
		backend: "elizacloud",
		transport: "cloud-proxy",
		accountId: "elizacloud",
		...pickOnboardingCloudModelPreferences(args),
	};
}

const LEGACY_CLOUD_ROUTING_KEYS = [
	"enabled",
	"provider",
	"remoteApiBase",
	"remoteAccessToken",
	"inferenceMode",
	"runtime",
] as const;

const LEGACY_CLOUD_SERVICE_KEYS = [
	"inference",
	"tts",
	"media",
	"embeddings",
	"rpc",
] as const;

function resolveLegacyDeploymentTargetInConfig(
	config: Record<string, unknown> | null | undefined,
): DeploymentTargetConfig {
	const cloud = asConfigRecord(config?.cloud);
	const remoteApiBase = readConfigString(cloud, "remoteApiBase");
	if (remoteApiBase) {
		return {
			runtime: "remote",
			provider: "remote",
			remoteApiBase,
			...(normalizeSecretString(cloud?.remoteAccessToken)
				? {
						remoteAccessToken: normalizeSecretString(cloud?.remoteAccessToken),
					}
				: {}),
		};
	}

	const cloudProvider = normalizeOnboardingProviderId(
		readConfigString(cloud, "provider"),
	);
	const cloudRuntime = readConfigString(cloud, "runtime");
	const cloudAgentId = readConfigString(cloud, "agentId");

	if (
		cloudRuntime === "cloud" &&
		cloudProvider === "elizacloud" &&
		cloudAgentId
	) {
		return { runtime: "cloud", provider: "elizacloud" };
	}

	return { runtime: "local" };
}

function resolveLegacyServiceRoutingInConfig(
	config: Record<string, unknown> | null | undefined,
): ServiceRoutingConfig | null {
	const root = asConfigRecord(config);
	const explicit = normalizeServiceRoutingConfig(root?.serviceRouting) ?? {};
	const next: ServiceRoutingConfig = { ...explicit };
	const deploymentTarget =
		normalizeDeploymentTargetConfig(root?.deploymentTarget) ??
		resolveLegacyDeploymentTargetInConfig(config);
	const cloud = asConfigRecord(config?.cloud);
	const cloudServices = asConfigRecord(cloud?.services);
	const models = asConfigRecord(config?.models);

	if (!next.llmText) {
		if (
			deploymentTarget.runtime === "remote" &&
			deploymentTarget.remoteApiBase
		) {
			const remotePrimaryModel = readPrimaryModelFromConfig(config);
			next.llmText = {
				backend: "remote",
				transport: "remote",
				remoteApiBase: deploymentTarget.remoteApiBase,
				...(remotePrimaryModel ? { primaryModel: remotePrimaryModel } : {}),
			};
		} else if (inferLegacyCloudInferenceSelection(config)) {
			next.llmText = buildElizaCloudTextRoute({
				smallModel: readConfigString(models, "small"),
				largeModel: readConfigString(models, "large"),
			});
		} else {
			const localProvider = resolveConfiguredLocalProviderFromSignals(config);
			const primaryModel = readPrimaryModelFromConfig(config);
			if (localProvider) {
				next.llmText = {
					backend: localProvider,
					transport: "direct",
					...(primaryModel ? { primaryModel } : {}),
				};
			}
		}
	}

	const legacyCloudServices: Array<
		["tts" | "media" | "embeddings" | "rpc", boolean | undefined]
	> = [
		[
			"tts",
			typeof cloudServices?.tts === "boolean" ? cloudServices.tts : undefined,
		],
		[
			"media",
			typeof cloudServices?.media === "boolean"
				? cloudServices.media
				: undefined,
		],
		[
			"embeddings",
			typeof cloudServices?.embeddings === "boolean"
				? cloudServices.embeddings
				: undefined,
		],
		[
			"rpc",
			typeof cloudServices?.rpc === "boolean" ? cloudServices.rpc : undefined,
		],
	];

	for (const [capability, legacyValue] of legacyCloudServices) {
		if (next[capability]) {
			continue;
		}
		if (legacyValue !== true) {
			continue;
		}
		next[capability] = {
			backend: "elizacloud",
			transport: "cloud-proxy",
			accountId: "elizacloud",
		};
	}

	return Object.keys(next).length > 0 ? next : null;
}

function pruneLegacyCloudRoutingFields(
	config: Record<string, unknown> | null | undefined,
): void {
	const root = asConfigRecord(config);
	const cloud = asConfigRecord(root?.cloud);
	if (!root || !cloud) {
		return;
	}

	for (const key of LEGACY_CLOUD_ROUTING_KEYS) {
		delete cloud[key];
	}

	const services = asConfigRecord(cloud.services);
	if (services) {
		for (const key of LEGACY_CLOUD_SERVICE_KEYS) {
			delete services[key];
		}
		if (Object.keys(services).length === 0) {
			delete cloud.services;
		} else {
			cloud.services = services;
		}
	}

	if (Object.keys(cloud).length === 0) {
		delete root.cloud;
	} else {
		root.cloud = cloud;
	}
}

export function migrateLegacyRuntimeConfig<T extends Record<string, unknown>>(
	config: T,
): T {
	const root = asConfigRecord(config);
	if (!root) {
		return config;
	}

	const deploymentTarget =
		normalizeDeploymentTargetConfig(root.deploymentTarget) ??
		resolveLegacyDeploymentTargetInConfig(root);
	if (
		deploymentTarget.runtime === "local" &&
		!Object.hasOwn(root, "deploymentTarget")
	) {
		// Keep local default implicit to avoid churn in brand-new configs.
	} else {
		root.deploymentTarget = deploymentTarget;
	}

	const linkedAccounts = resolveLinkedAccountsInConfig(root);
	if (linkedAccounts) {
		root.linkedAccounts = linkedAccounts;
	} else {
		delete root.linkedAccounts;
	}

	const serviceRouting =
		normalizeServiceRoutingConfig(root.serviceRouting) ??
		resolveLegacyServiceRoutingInConfig(root);
	if (serviceRouting) {
		root.serviceRouting = serviceRouting;
	} else {
		delete root.serviceRouting;
	}

	if (Object.hasOwn(root, "connection")) {
		delete root.connection;
	}

	pruneLegacyCloudRoutingFields(root);
	return config;
}

export function resolveLinkedAccountsInConfig(
	config: Record<string, unknown> | null | undefined,
): LinkedAccountFlagsConfig | null {
	const root = asConfigRecord(config);
	const explicit =
		normalizeLinkedAccountFlagsConfig(root?.linkedAccounts) ?? {};
	const next: LinkedAccountFlagsConfig = { ...explicit };
	const cloud = asConfigRecord(config?.cloud);
	const hasCloudKey = Boolean(normalizeSecretString(cloud?.apiKey));
	const existingCloudAccount = next.elizacloud;

	if (hasCloudKey && !existingCloudAccount?.status) {
		next.elizacloud = {
			...existingCloudAccount,
			status: "linked",
			source: existingCloudAccount?.source ?? "api-key",
		};
	}

	return Object.keys(next).length > 0 ? next : null;
}

export function resolveDeploymentTargetInConfig(
	config: Record<string, unknown> | null | undefined,
): DeploymentTargetConfig {
	const root = asConfigRecord(config);
	const explicit = normalizeDeploymentTargetConfig(root?.deploymentTarget);
	if (explicit) {
		return explicit;
	}

	return { runtime: "local" };
}

export function resolveServiceRoutingInConfig(
	config: Record<string, unknown> | null | undefined,
): ServiceRoutingConfig | null {
	const root = asConfigRecord(config);
	const explicit = normalizeServiceRoutingConfig(root?.serviceRouting) ?? {};
	const next: ServiceRoutingConfig = { ...explicit };
	const deploymentTarget = resolveDeploymentTargetInConfig(config);

	if (!next.llmText) {
		if (
			deploymentTarget.runtime === "remote" &&
			deploymentTarget.remoteApiBase
		) {
			const remotePrimaryModel = readPrimaryModelFromConfig(config);
			next.llmText = {
				backend: "remote",
				transport: "remote",
				remoteApiBase: deploymentTarget.remoteApiBase,
				...(remotePrimaryModel ? { primaryModel: remotePrimaryModel } : {}),
			};
		} else {
			const localProvider = resolveConfiguredLocalProviderFromSignals(config);
			const primaryModel = readPrimaryModelFromConfig(config);
			if (localProvider) {
				next.llmText = {
					backend: localProvider,
					transport: "direct",
					...(primaryModel ? { primaryModel } : {}),
				};
			}
		}
	}

	return Object.keys(next).length > 0 ? next : null;
}

function deriveOnboardingConnectionFromRuntimeConfig(
	config: Record<string, unknown> | null | undefined,
): OnboardingConnection | null {
	const routing = resolveServiceRoutingInConfig(config);
	const deploymentTarget = resolveDeploymentTargetInConfig(config);
	const llmText = routing?.llmText;
	const backend = normalizeOnboardingProviderId(llmText?.backend);
	const routeApiKey = readOnboardingProviderApiKey(config, backend);

	if (llmText?.transport === "cloud-proxy" && backend === "elizacloud") {
		return {
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			...pickOnboardingCloudModelPreferences(llmText),
		};
	}

	if (llmText?.transport === "remote") {
		const remoteApiBase =
			llmText.remoteApiBase ?? deploymentTarget.remoteApiBase;
		if (!remoteApiBase) {
			return null;
		}
		return {
			kind: "remote-provider",
			remoteApiBase,
			...(deploymentTarget.remoteAccessToken
				? { remoteAccessToken: deploymentTarget.remoteAccessToken }
				: {}),
			...(backend && backend !== "elizacloud" ? { provider: backend } : {}),
			...(routeApiKey ? { apiKey: routeApiKey } : {}),
			...(llmText.primaryModel ? { primaryModel: llmText.primaryModel } : {}),
		};
	}

	if (backend && backend !== "elizacloud") {
		return {
			kind: "local-provider",
			provider: backend,
			...(routeApiKey ? { apiKey: routeApiKey } : {}),
			...(llmText?.primaryModel ? { primaryModel: llmText.primaryModel } : {}),
		};
	}

	if (
		deploymentTarget.runtime === "remote" &&
		deploymentTarget.remoteApiBase?.trim()
	) {
		return {
			kind: "remote-provider",
			remoteApiBase: deploymentTarget.remoteApiBase,
			...(deploymentTarget.remoteAccessToken
				? { remoteAccessToken: deploymentTarget.remoteAccessToken }
				: {}),
		};
	}

	return null;
}

function resolveConfiguredLocalProviderFromSignals(
	config: Record<string, unknown> | null | undefined,
): OnboardingLocalProviderId | null {
	const agents = asConfigRecord(config?.agents);
	const defaults = asConfigRecord(agents?.defaults);
	const storedSubscriptionProvider = normalizeOnboardingProviderId(
		readConfigString(defaults, "subscriptionProvider"),
	);
	if (
		storedSubscriptionProvider &&
		storedSubscriptionProvider !== "elizacloud" &&
		!requiresAdditionalRuntimeProvider(storedSubscriptionProvider)
	) {
		return storedSubscriptionProvider;
	}

	for (const provider of ONBOARDING_PROVIDER_CATALOG) {
		if (provider.id === "elizacloud") {
			continue;
		}
		const providerId = provider.id as OnboardingLocalProviderId;
		const detected = getOnboardingProviderSignalEnvKeys(providerId).some(
			(key) => Boolean(readOnboardingEnvString(config, key)),
		);
		if (detected) {
			return providerId;
		}
	}

	return null;
}

export function normalizePersistedOnboardingConnection(
	value: unknown,
): OnboardingConnection | null {
	const connection = asConfigRecord(value);
	if (!connection) {
		return null;
	}

	if (connection.kind === "cloud-managed") {
		return {
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			apiKey: normalizeSecretString(connection.apiKey),
			...readOnboardingCloudModelPreferences(connection),
		};
	}

	if (connection.kind === "local-provider") {
		const provider = normalizeOnboardingProviderId(connection.provider);
		if (!provider || provider === "elizacloud") {
			return null;
		}
		return {
			kind: "local-provider",
			provider,
			apiKey: normalizeSecretString(connection.apiKey),
			primaryModel: readConfigString(connection, "primaryModel"),
		};
	}

	if (connection.kind === "remote-provider") {
		const remoteApiBase = readConfigString(connection, "remoteApiBase");
		const provider = normalizeOnboardingProviderId(connection.provider);
		if (!remoteApiBase) {
			return null;
		}
		return {
			kind: "remote-provider",
			remoteApiBase,
			remoteAccessToken: normalizeSecretString(connection.remoteAccessToken),
			provider: provider && provider !== "elizacloud" ? provider : undefined,
			apiKey: normalizeSecretString(connection.apiKey),
			primaryModel: readConfigString(connection, "primaryModel"),
		};
	}

	return null;
}

export function normalizeOnboardingCredentialInputs(
	value: unknown,
): OnboardingCredentialInputs | null {
	const inputs = asConfigRecord(value);
	if (!inputs) {
		return null;
	}

	const llmApiKey = normalizeSecretString(inputs.llmApiKey);
	const cloudApiKey = normalizeSecretString(inputs.cloudApiKey);

	if (!llmApiKey && !cloudApiKey) {
		return null;
	}

	return {
		...(llmApiKey ? { llmApiKey } : {}),
		...(cloudApiKey ? { cloudApiKey } : {}),
	};
}

export interface OnboardingCredentialPersistencePlan {
	llmSelection: OnboardingLlmPersistenceSelection | null;
	cloudApiKey?: string;
}

export function deriveOnboardingCredentialPersistencePlan(args: {
	credentialInputs?: OnboardingCredentialInputs | null;
	deploymentTarget?: DeploymentTargetConfig | null;
	serviceRouting?: ServiceRoutingConfig | null;
}): OnboardingCredentialPersistencePlan {
	const credentialInputs = normalizeOnboardingCredentialInputs(
		args.credentialInputs,
	);
	const deploymentTarget = normalizeDeploymentTargetConfig(
		args.deploymentTarget,
	);
	const serviceRouting = normalizeServiceRoutingConfig(args.serviceRouting);
	const llmRoute = serviceRouting?.llmText;

	const cloudApiKey = credentialInputs?.cloudApiKey;
	const llmApiKey = credentialInputs?.llmApiKey;

	if (
		llmRoute?.transport === "cloud-proxy" &&
		normalizeOnboardingProviderId(llmRoute.backend) === "elizacloud" &&
		cloudApiKey
	) {
		return {
			llmSelection: {
				backend: "elizacloud",
				transport: "cloud-proxy",
				apiKey: cloudApiKey,
				...pickOnboardingCloudModelPreferences(llmRoute),
			},
			cloudApiKey,
		};
	}

	if (llmRoute?.transport === "direct" && llmApiKey) {
		const provider = normalizeOnboardingProviderId(llmRoute.backend);
		if (provider && provider !== "elizacloud") {
			return {
				llmSelection: {
					backend: provider,
					transport: "direct",
					apiKey: llmApiKey,
					...(llmRoute.primaryModel
						? { primaryModel: llmRoute.primaryModel }
						: {}),
				},
				...(cloudApiKey ? { cloudApiKey } : {}),
			};
		}
	}

	if (llmRoute?.transport === "remote" && llmApiKey) {
		const provider = normalizeOnboardingProviderId(llmRoute.backend);
		const remoteApiBase =
			llmRoute.remoteApiBase ?? deploymentTarget?.remoteApiBase;
		if (provider && provider !== "elizacloud" && remoteApiBase) {
			return {
				llmSelection: {
					backend: provider,
					transport: "remote",
					remoteApiBase,
					...(deploymentTarget?.remoteAccessToken
						? { remoteAccessToken: deploymentTarget.remoteAccessToken }
						: {}),
					apiKey: llmApiKey,
					...(llmRoute.primaryModel
						? { primaryModel: llmRoute.primaryModel }
						: {}),
				},
				...(cloudApiKey ? { cloudApiKey } : {}),
			};
		}
	}

	return {
		llmSelection: null,
		...(cloudApiKey ? { cloudApiKey } : {}),
	};
}

export function stripOnboardingConnectionSecrets(
	connection: OnboardingConnection,
): OnboardingConnection {
	if (connection.kind === "cloud-managed") {
		return {
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			...pickOnboardingCloudModelPreferences(connection),
		};
	}

	if (connection.kind === "local-provider") {
		return {
			kind: "local-provider",
			provider: connection.provider,
			primaryModel: connection.primaryModel,
		};
	}

	return {
		kind: "remote-provider",
		remoteApiBase: connection.remoteApiBase,
		provider: connection.provider,
		primaryModel: connection.primaryModel,
	};
}

export function inferCompatibilityOnboardingConnection(
	config: Record<string, unknown> | null | undefined,
): OnboardingConnection | null {
	const cloud = asConfigRecord(config?.cloud);
	const models = asConfigRecord(config?.models);
	const remoteApiBase = readConfigString(cloud, "remoteApiBase");
	const remoteAccessToken = normalizeSecretString(cloud?.remoteAccessToken);
	const localProvider = resolveConfiguredLocalProviderFromSignals(config);
	const primaryModel = readPrimaryModelFromConfig(config);
	const localApiKey = readOnboardingProviderApiKey(config, localProvider);

	if (remoteApiBase) {
		return {
			kind: "remote-provider",
			remoteApiBase,
			remoteAccessToken,
			provider: localProvider ?? undefined,
			apiKey: localApiKey,
			primaryModel,
		};
	}

	const cloudProvider = normalizeOnboardingProviderId(
		readConfigString(cloud, "provider"),
	);
	const cloudApiKey = normalizeSecretString(cloud?.apiKey);
	const nanoModel = readConfigString(models, "nano");
	const smallModel = readConfigString(models, "small");
	const mediumModel = readConfigString(models, "medium");
	const largeModel = readConfigString(models, "large");
	const megaModel = readConfigString(models, "mega");
	const cloudExplicitlyDisabled = cloud?.enabled === false;

	if (
		!cloudExplicitlyDisabled &&
		(cloud?.enabled === true ||
			cloudProvider === "elizacloud" ||
			readConfigString(cloud, "inferenceMode") === "cloud" ||
			nanoModel ||
			smallModel ||
			mediumModel ||
			largeModel ||
			megaModel)
	) {
		return {
			kind: "cloud-managed",
			cloudProvider: "elizacloud",
			apiKey: cloudApiKey,
			nanoModel,
			smallModel,
			mediumModel,
			largeModel,
			megaModel,
		};
	}

	if (!localProvider) {
		return null;
	}

	return {
		kind: "local-provider",
		provider: localProvider,
		apiKey: localApiKey,
		primaryModel,
	};
}

export function inferOnboardingConnectionFromConfig(
	config: Record<string, unknown> | null | undefined,
): OnboardingConnection | null {
	return deriveOnboardingConnectionFromRuntimeConfig(config);
}

function inferLegacyCloudInferenceSelection(
	config: Record<string, unknown> | null | undefined,
): boolean {
	const cloud = asConfigRecord(config?.cloud);
	if (cloud?.enabled === false) {
		return false;
	}

	const services = asConfigRecord(cloud?.services);
	const inferenceMode = readConfigString(cloud, "inferenceMode");
	if (
		inferenceMode === "byok" ||
		inferenceMode === "local" ||
		services?.inference === false
	) {
		return false;
	}

	const cloudProvider = normalizeOnboardingProviderId(
		readConfigString(cloud, "provider"),
	);
	const models = asConfigRecord(config?.models);
	const nanoModel = readConfigString(models, "nano");
	const smallModel = readConfigString(models, "small");
	const mediumModel = readConfigString(models, "medium");
	const largeModel = readConfigString(models, "large");
	const megaModel = readConfigString(models, "mega");

	return Boolean(
		cloud?.enabled === true ||
			cloudProvider === "elizacloud" ||
			inferenceMode === "cloud" ||
			nanoModel ||
			smallModel ||
			mediumModel ||
			largeModel ||
			megaModel,
	);
}

export function isCloudInferenceSelectedInConfig(
	config: Record<string, unknown> | null | undefined,
): boolean {
	const routing = resolveServiceRoutingInConfig(config);
	const llmText = routing?.llmText;
	return Boolean(
		llmText?.transport === "cloud-proxy" &&
			normalizeOnboardingProviderId(llmText.backend) === "elizacloud",
	);
}

// ---------------------------------------------------------------------------
// Provider option registry — allows plugins to register additional providers
// at runtime without modifying the hardcoded ONBOARDING_PROVIDER_CATALOG.
// ---------------------------------------------------------------------------

const _registeredProviderOptions: ProviderOption[] = [];

/**
 * Register an additional provider option at runtime.
 * Plugins should call this during initialization to add themselves to the
 * onboarding provider catalog.
 */
export function registerProviderOption(option: ProviderOption): void {
	const existing = _registeredProviderOptions.findIndex(
		(o) => o.id === option.id,
	);
	if (existing >= 0) {
		_registeredProviderOptions[existing] = option;
	} else {
		_registeredProviderOptions.push(option);
	}
}

/**
 * Get all provider options: hardcoded catalog merged with runtime-registered
 * providers. Runtime registrations override hardcoded entries with the same id.
 */
export function getProviderOptions(): ProviderOption[] {
	const merged = new Map<string, ProviderOption>();
	for (const option of ONBOARDING_PROVIDER_CATALOG) {
		merged.set(option.id, option as ProviderOption);
	}
	for (const option of _registeredProviderOptions) {
		merged.set(option.id, option);
	}
	return Array.from(merged.values());
}
