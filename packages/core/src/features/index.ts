/**
 * Core Capabilities — Infrastructure services that are independently gated.
 *
 * Unlike advanced-capabilities (gated by `advancedCapabilities: true`),
 * these are enabled via their own flags:
 * - `enableTrust: true` / `ENABLE_TRUST` — trust engine, security, permissions
 * - `enableSecretsManager: true` / `ENABLE_SECRETS_MANAGER` — encrypted secrets, plugin activation
 * - `enablePluginManager: true` / `ENABLE_PLUGIN_MANAGER` — plugin introspection, install/eject
 *
 * Actions and providers are populated eagerly from each capability's index so
 * they are registered with the runtime alongside the lazy-started services.
 */

import { promoteSubactionsToActions } from "../actions/promote-subactions.ts";
import { createService } from "../services.ts";
import type { Action, Provider } from "../types/index.ts";
import type { ServiceClass } from "../types/plugin.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

// ─── Trust ────────────────────────────────────────────────────────────────────

// Eagerly import trust components so they are available to the runtime's
// action planner and provider composition.
//
// Direct leaf-file imports — see comment in
// ./advanced-capabilities/index.ts for the Bun.build mis-rewrite that
// requires bypassing barrels here too.
import { trustAction } from "./trust/actions/trust.ts";
import { adminTrustProvider } from "./trust/providers/adminTrust.ts";
import { roleProvider as trustRoleProvider } from "./trust/providers/roles.ts";
import { securityStatusProvider } from "./trust/providers/securityStatus.ts";
import { settingsProvider as trustSettingsProvider } from "./trust/providers/settings.ts";
import { trustProfileProvider } from "./trust/providers/trustProfile.ts";

const trustCapability = {
	providers: [
		trustRoleProvider,
		trustSettingsProvider,
		trustProfileProvider,
		securityStatusProvider,
		adminTrustProvider,
	] as Provider[],
	actions: [...promoteSubactionsToActions(trustAction)] as Action[],
	services: [
		createService("trust-engine")
			.withDescription("Trust profile, evidence, and policy evaluation")
			.withStart(async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.TrustEngineServiceWrapper.start(runtime);
			})
			.build(),
		createService("security-module")
			.withDescription("Trust security module")
			.withStart(async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.SecurityModuleServiceWrapper.start(runtime);
			})
			.build(),
		createService("credential-protector")
			.withDescription("Credential risk protection")
			.withStart(async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.CredentialProtectorServiceWrapper.start(runtime);
			})
			.build(),
		createService("contextual-permissions")
			.withDescription("Contextual permission checks")
			.withStart(async (runtime: IAgentRuntime) => {
				const mod = await import("./trust/index.ts");
				return mod.ContextualPermissionSystemServiceWrapper.start(runtime);
			})
			.build(),
	] as ServiceClass[],
	async init(runtime: IAgentRuntime): Promise<void> {
		const { ensureAdminRoleOnInit } = await import("./trust/index.ts");
		await ensureAdminRoleOnInit(runtime);
	},
};

// ─── Secrets Manager ──────────────────────────────────────────────────────────

// Direct leaf-file imports — see comment in
// ./advanced-capabilities/index.ts for the Bun.build mis-rewrite that
// requires bypassing barrels.
import { secretsAction } from "./secrets/actions/manage-secret.ts";
import { updateSettingsAction as onboardingUpdateSettingsAction } from "./secrets/onboarding/action.ts";
import {
	missingSecretsProvider,
	onboardingSettingsProvider,
} from "./secrets/onboarding/provider.ts";
import { OnboardingService } from "./secrets/onboarding/service.ts";
import {
	secretsInfoProvider,
	secretsStatusProvider,
} from "./secrets/providers/secrets-status.ts";
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
		...promoteSubactionsToActions(secretsAction),
		onboardingUpdateSettingsAction,
	] as Action[],
	services: [
		createService("SECRETS")
			.withDescription("Secrets manager")
			.withStart(async (runtime: IAgentRuntime) => {
				return SecretsService.start(runtime);
			})
			.build(),
		createService("PLUGIN_ACTIVATOR")
			.withDescription("Plugin activation service")
			.withStart(async (runtime: IAgentRuntime) => {
				return PluginActivatorService.start(runtime);
			})
			.build(),
		createService("ONBOARDING")
			.withDescription("Secrets onboarding service")
			.withStart(async (runtime: IAgentRuntime) => {
				return OnboardingService.start(runtime);
			})
			.build(),
	] as ServiceClass[],
};

// ─── Plugin Manager ───────────────────────────────────────────────────────────

// Direct leaf imports — see comment in ./advanced-capabilities/index.ts.
import { pluginAction } from "./plugin-manager/actions/plugin.ts";
import { pluginConfigurationStatusProvider } from "./plugin-manager/providers/pluginConfigurationStatus.ts";
import { pluginStateProvider } from "./plugin-manager/providers/pluginStateProvider.ts";
import { registryPluginsProvider } from "./plugin-manager/providers/registryPluginsProvider.ts";
import { CoreManagerService } from "./plugin-manager/services/coreManagerService.ts";
import { PluginManagerService } from "./plugin-manager/services/pluginManagerService.ts";

const pluginManagerCapability = {
	providers: [
		pluginConfigurationStatusProvider,
		pluginStateProvider,
		registryPluginsProvider,
	] as Provider[],
	actions: [pluginAction] as Action[],
	services: [
		createService("plugin_manager")
			.withDescription("Plugin management service")
			.withStart(async (runtime: IAgentRuntime) => {
				return PluginManagerService.start(runtime);
			})
			.build(),
		createService("core_manager")
			.withDescription("Core management service")
			.withStart(async (runtime: IAgentRuntime) => {
				return CoreManagerService.start(runtime);
			})
			.build(),
	] as ServiceClass[],
};

// ─── Documents & trajectories (native RAG / run logging) ──────────────────────

export type {
	DocumentsPluginConfig,
	FetchDocumentFromUrlOptions,
	FetchedDocumentUrl,
	FetchedDocumentUrlKind,
} from "./documents/index";
export {
	createDocumentsPlugin,
	DocumentService,
	documentAction,
	documentActions,
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
