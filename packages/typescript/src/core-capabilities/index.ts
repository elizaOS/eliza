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
	updateRoleAction as trustUpdateRoleAction,
	updateSettingsAction as trustUpdateSettingsAction,
	recordTrustInteractionAction,
	evaluateTrustAction,
	requestElevationAction,
} from "./trust/actions/index.ts";
import {
	roleProvider as trustRoleProvider,
	settingsProvider as trustSettingsProvider,
	trustProfileProvider,
	securityStatusProvider,
	adminTrustProvider,
} from "./trust/providers/index.ts";
import {
	securityEvaluator,
	reflectionEvaluator as trustReflectionEvaluator,
	trustChangeEvaluator,
} from "./trust/evaluators/index.ts";

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
		trustUpdateSettingsAction,
		recordTrustInteractionAction,
		evaluateTrustAction,
		requestElevationAction,
	] as Action[],
	evaluators: [
		securityEvaluator,
		trustReflectionEvaluator,
		trustChangeEvaluator,
	] as Evaluator[],
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
	setSecretAction,
	manageSecretAction,
	requestSecretAction,
} from "./secrets/actions/index.ts";
import {
	secretsStatusProvider,
	secretsInfoProvider,
} from "./secrets/providers/index.ts";
import {
	updateSettingsAction as onboardingUpdateSettingsAction,
	onboardingSettingsProvider,
	missingSecretsProvider,
} from "./secrets/onboarding/index.ts";

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
				const { SecretsService } = await import(
					"./secrets/services/secrets.ts"
				);
				return SecretsService.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "PLUGIN_ACTIVATOR",
			start: async (runtime: IAgentRuntime) => {
				const { PluginActivatorService } = await import(
					"./secrets/services/plugin-activator.ts"
				);
				return PluginActivatorService.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "ONBOARDING",
			start: async (runtime: IAgentRuntime) => {
				const { OnboardingService } = await import(
					"./secrets/onboarding/service.ts"
				);
				return OnboardingService.start(runtime);
			},
		} as unknown as ServiceClass,
	] as ServiceClass[],
};

// ─── Plugin Manager ───────────────────────────────────────────────────────────

import {
	coreStatusAction,
	searchPluginAction,
	getPluginDetailsAction,
	listEjectedPluginsAction,
} from "./plugin-manager/index.ts";
import {
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
	actions: [
		coreStatusAction,
		searchPluginAction,
		getPluginDetailsAction,
		listEjectedPluginsAction,
	] as Action[],
	services: [
		{
			serviceType: "plugin_manager",
			start: async (runtime: IAgentRuntime) => {
				const { PluginManagerService } = await import(
					"./plugin-manager/services/pluginManagerService.ts"
				);
				return PluginManagerService.start(runtime);
			},
		} as unknown as ServiceClass,
		{
			serviceType: "core_manager",
			start: async (runtime: IAgentRuntime) => {
				const { CoreManagerService } = await import(
					"./plugin-manager/services/coreManagerService.ts"
				);
				return CoreManagerService.start(runtime);
			},
		} as unknown as ServiceClass,
	] as ServiceClass[],
};

// ─── Exports ──────────────────────────────────────────────────────────────────

export { trustCapability, secretsCapability, pluginManagerCapability };

export const coreCapabilities = {
	trust: trustCapability,
	secretsManager: secretsCapability,
	pluginManager: pluginManagerCapability,
};

export default coreCapabilities;
