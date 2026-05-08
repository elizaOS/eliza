/**
 * Core Capabilities — Infrastructure services that are independently gated.
 *
 * Unlike advanced-capabilities (gated by `advancedCapabilities: true`),
 * these are enabled via their own flags:
 * - `enableTrust: true` / `ENABLE_TRUST` — trust engine, security, permissions
 * - `enableSecretsManager: true` / `ENABLE_SECRETS_MANAGER` — encrypted secrets, plugin activation
 * - `enablePluginManager: true` / `ENABLE_PLUGIN_MANAGER` — plugin introspection, install/eject
 *
 * Actions, providers, and evaluators are populated eagerly from each capability's
 * index so they are registered with the runtime alongside the lazy-started services.
 */

import type { Action, Evaluator, Provider } from "../types/index.ts";
import type { ServiceClass } from "../types/plugin.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

// ─── Trust ────────────────────────────────────────────────────────────────────

// Eagerly import trust components so they are available to the runtime's
// action planner, provider composition, and evaluator loop.
import {
	evaluateTrustAction,
	recordTrustInteractionAction,
	requestElevationAction,
	updateRoleAction as trustUpdateRoleAction,
} from "./trust/actions/index.ts";
import {
	adminTrustProvider,
	securityStatusProvider,
	trustProfileProvider,
	roleProvider as trustRoleProvider,
	settingsProvider as trustSettingsProvider,
} from "./trust/providers/index.ts";

const trustCapability = {
	providers: [
		trustRoleProvider,
		trustSettingsProvider,
		trustProfileProvider,
		securityStatusProvider,
		adminTrustProvider,
	] as Provider[],
	actions: [
		trustUpdateRoleAction,
		recordTrustInteractionAction,
		evaluateTrustAction,
		requestElevationAction,
	] as Action[],
	evaluators: [] as Evaluator[],
	services: [
		{
			serviceType: "trust-engine",
			start: async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.TrustEngineServiceWrapper.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "security-module",
			start: async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.SecurityModuleServiceWrapper.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "credential-protector",
			start: async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.CredentialProtectorServiceWrapper.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "contextual-permissions",
			start: async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.ContextualPermissionSystemServiceWrapper.start(runtime);
			},
		} as unknown as ServiceClass,
	] as ServiceClass[],
	async init(runtime: IAgentRuntime): Promise<void> {
		const { ensureAdminRoleOnInit } = await import("./trust/index.ts");
		await ensureAdminRoleOnInit(runtime);
	},
};

// ─── Secrets Manager ──────────────────────────────────────────────────────────

import {
	manageSecretAction,
	requestSecretAction,
	setSecretAction,
} from "./secrets/actions/index.ts";
import {
	missingSecretsProvider,
	onboardingSettingsProvider,
	updateSettingsAction as onboardingUpdateSettingsAction,
} from "./secrets/onboarding/index.ts";
import { OnboardingService } from "./secrets/onboarding/service.ts";
import {
	secretsInfoProvider,
	secretsStatusProvider,
} from "./secrets/providers/index.ts";
import { PluginActivatorService } from "./secrets/services/plugin-activator.ts";
import { SecretsService } from "./secrets/services/secrets.ts";

const secretsCapability = {
	providers: [
		secretsStatusProvider,
		secretsInfoProvider,
		onboardingSettingsProvider,
		missingSecretsProvider,
	] as Provider[],
	actions: [
		setSecretAction,
		manageSecretAction,
		requestSecretAction,
		onboardingUpdateSettingsAction,
	] as Action[],
	services: [
		{
			serviceType: "SECRETS",
			start: async (runtime: IAgentRuntime) => {
				return SecretsService.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "PLUGIN_ACTIVATOR",
			start: async (runtime: IAgentRuntime) => {
				return PluginActivatorService.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "ONBOARDING",
			start: async (runtime: IAgentRuntime) => {
				return OnboardingService.start(runtime);
			},
		} as unknown as ServiceClass,
	] as ServiceClass[],
};

// ─── Plugin Manager ───────────────────────────────────────────────────────────

import {
	CoreManagerService,
	PluginManagerService,
	pluginAction,
	pluginConfigurationStatusProvider,
	pluginStateProvider,
	registryPluginsProvider,
} from "./plugin-manager/index.ts";

const pluginManagerCapability = {
	providers: [
		pluginConfigurationStatusProvider,
		pluginStateProvider,
		registryPluginsProvider,
	] as Provider[],
	actions: [pluginAction] as Action[],
	services: [
		{
			serviceType: "plugin_manager",
			start: async (runtime: IAgentRuntime) => {
				return PluginManagerService.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "core_manager",
			start: async (runtime: IAgentRuntime) => {
				return CoreManagerService.start(runtime);
			},
		} as unknown as ServiceClass,
	] as ServiceClass[],
};

// ─── Documents & trajectories (native RAG / run logging) ──────────────────────

export type {
	DocumentsPluginConfig,
	FetchedDocumentUrl,
	FetchedDocumentUrlKind,
	FetchDocumentFromUrlOptions,
} from "./documents/index";
export {
	createDocumentsPlugin,
	documentAction,
	documentActions,
	DocumentService,
	documentsPlugin,
	documentsPluginCore,
	documentsPluginHeadless,
	documentsProvider,
	fetchDocumentFromUrl,
	isYouTubeUrl,
} from "./documents/index";
export type {
	TrajectoryExportOptions,
	TrajectoryListItem,
	TrajectoryListOptions,
	TrajectoryListResult,
	TrajectoryStats,
	TrajectoryZipEntry,
	TrajectoryZipExportOptions,
	TrajectoryZipExportResult,
} from "./trajectories/index.ts";
export {
	TrajectoriesService,
	trajectoriesPlugin,
} from "./trajectories/index.ts";

// ─── Exports ──────────────────────────────────────────────────────────────────

export { pluginManagerCapability, secretsCapability, trustCapability };

export const coreCapabilities = {
	trust: trustCapability,
	secretsManager: secretsCapability,
	pluginManager: pluginManagerCapability,
};

export default coreCapabilities;
