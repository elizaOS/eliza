/**
 * Core Capabilities — Infrastructure services that are independently gated.
 *
 * Unlike advanced-capabilities (gated by `advancedCapabilities: true`),
 * these are enabled via their own flags:
 * - `enableTrust: true` / `ENABLE_TRUST` — trust engine, security, permissions
 * - `enableSecretsManager: true` / `ENABLE_SECRETS_MANAGER` — encrypted secrets, plugin activation
 *
 * Actions and providers are populated eagerly from each capability's index so
 * they are registered with the runtime alongside the lazy-started services.
 */

import { promoteSubactionsToActions } from "@elizaos/core";
import { createService } from "@elizaos/core";
import type { Action, Provider } from "@elizaos/core";
import type { ServiceClass } from "@elizaos/core";
import type { IAgentRuntime } from "@elizaos/core";

// ─── Trust ────────────────────────────────────────────────────────────────────

// Eagerly import trust components so they are available to the runtime's
// action planner and provider composition.
//
// Direct leaf-file imports — see comment in
// ./advanced-capabilities/index.ts for the Bun.build mis-rewrite that
// requires bypassing barrels here too.
import { trustAction } from "./trust/actions/trust.ts";
import { adminTrustProvider } from "./trust/providers/adminTrust.ts";
import { securityStatusProvider } from "./trust/providers/securityStatus.ts";
import { trustProfileProvider } from "./trust/providers/trustProfile.ts";

const trustCapability = {
  providers: [
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
import {
  secretsInfoProvider,
  secretsStatusProvider,
} from "./secrets/providers/secrets-status.ts";
import { PluginActivatorService } from "./secrets/services/plugin-activator.ts";
import { SecretsService } from "./secrets/services/secrets.ts";
import { updateSettingsAction as setupUpdateSettingsAction } from "./secrets/setup/action.ts";
import {
  missingSecretsProvider,
  setupSettingsProvider,
} from "./secrets/setup/provider.ts";
import { SetupService } from "./secrets/setup/service.ts";

const secretsCapability = {
  providers: [
    secretsStatusProvider,
    secretsInfoProvider,
    setupSettingsProvider,
    missingSecretsProvider,
  ] as Provider[],
  actions: [secretsAction, setupUpdateSettingsAction] as Action[],
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
    createService("SETUP")
      .withDescription("Secrets setup service")
      .withStart(async (runtime: IAgentRuntime) => {
        return SetupService.start(runtime);
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

export { secretsCapability, trustCapability };

export const coreCapabilities = {
  trust: trustCapability,
  secretsManager: secretsCapability,
};

export default coreCapabilities;
