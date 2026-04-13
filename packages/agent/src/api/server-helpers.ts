/**
 * General-purpose helper functions extracted from server.ts.
 *
 * Utility functions for plugin services, UUID validation, state persistence,
 * onboarding, config, and package root resolution.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type AgentRuntime,
  type UUID,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeOnboardingProviderId,
  resolveDeploymentTargetInConfig,
  resolveServiceRoutingInConfig,
} from "../contracts/onboarding.js";
import {
  type AgentEventServiceLike,
  getAgentEventService,
} from "../runtime/agent-event-service.js";
import {
  type CoreManagerLike,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginManagerLike,
} from "../services/plugin-manager-types.js";
import {
  normalizeCharacterLanguage,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
  resolveStylePresetByName,
} from "../onboarding-presets.js";

// ---------------------------------------------------------------------------
// Pi AI plugin lazy loader
// ---------------------------------------------------------------------------

// @ts-ignore — plugin-pi-ai may not be installed
type PiAiPluginModule = typeof import("@elizaos/plugin-pi-ai");
let _piAiPluginModule: PiAiPluginModule | null = null;
export async function loadPiAiPluginModule(): Promise<PiAiPluginModule> {
  if (!_piAiPluginModule) {
    // @ts-ignore — plugin-pi-ai may not be installed
    _piAiPluginModule = await import("@elizaos/plugin-pi-ai");
  }
  return _piAiPluginModule;
}

// ---------------------------------------------------------------------------
// Service accessors
// ---------------------------------------------------------------------------

export function getAgentEventSvc(
  runtime: AgentRuntime | null,
): AgentEventServiceLike | null {
  return getAgentEventService(runtime);
}

export function requirePluginManager(runtime: AgentRuntime | null): PluginManagerLike {
  const service = runtime?.getService("plugin_manager");
  if (!isPluginManagerLike(service)) {
    throw new Error("Plugin manager service not found");
  }
  return service;
}

export function requireCoreManager(runtime: AgentRuntime | null): CoreManagerLike {
  const service = runtime?.getService("core_manager");
  if (!isCoreManagerLike(service)) {
    throw new Error("Core manager service not found");
  }
  return service;
}

// ---------------------------------------------------------------------------
// UUID validation
// ---------------------------------------------------------------------------

export function isUuidLike(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

// ---------------------------------------------------------------------------
// Deleted conversations state management
// ---------------------------------------------------------------------------

const OG_FILENAME = ".og";
const DELETED_CONVERSATIONS_FILENAME = "deleted-conversations.v1.json";
const MAX_DELETED_CONVERSATION_IDS = 5000;

export interface DeletedConversationsStateFile {
  version: 1;
  updatedAt: string;
  ids: string[];
}

export function readDeletedConversationIdsFromState(): Set<string> {
  const filePath = path.join(resolveStateDir(), DELETED_CONVERSATIONS_FILENAME);
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeletedConversationsStateFile>;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    return new Set(
      ids
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    );
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to read deleted conversations state: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Set();
  }
}

export function persistDeletedConversationIdsToState(ids: Set<string>): void {
  const dir = resolveStateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const normalized = Array.from(ids)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(-MAX_DELETED_CONVERSATION_IDS);

  const filePath = path.join(dir, DELETED_CONVERSATIONS_FILENAME);
  const tmpFilePath = `${filePath}.${process.pid}.tmp`;
  const payload: DeletedConversationsStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ids: normalized,
  };

  fs.writeFileSync(tmpFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.renameSync(tmpFilePath, filePath);
}

// ---------------------------------------------------------------------------
// OG code state management
// ---------------------------------------------------------------------------

export function readOGCodeFromState(): string | null {
  const filePath = path.join(resolveStateDir(), OG_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8").trim();
}

export function initializeOGCodeInState(): void {
  const dir = resolveStateDir();
  const filePath = path.join(dir, OG_FILENAME);
  if (fs.existsSync(filePath)) return;

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, crypto.randomUUID(), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata for a web-chat conversation. */
export interface ConversationMeta {
  id: string;
  title: string;
  roomId: UUID;
  createdAt: string;
  updatedAt: string;
}

export interface AgentStartupDiagnostics {
  phase: string;
  attempt: number;
  lastError?: string;
  lastErrorAt?: number;
  nextRetryAt?: number;
}

// ---------------------------------------------------------------------------
// Onboarding & config helpers
// ---------------------------------------------------------------------------

export function hasPersistedOnboardingState(config: ElizaConfig): boolean {
  if (config.meta?.onboardingComplete === true) {
    return true;
  }

  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = normalizeOnboardingProviderId(llmText?.backend);
  const remoteApiBase =
    llmText?.remoteApiBase?.trim() ?? deploymentTarget.remoteApiBase?.trim();
  const hasCompleteCanonicalRouting =
    (llmText?.transport === "direct" &&
      Boolean(backend && backend !== "elizacloud")) ||
    (llmText?.transport === "remote" && Boolean(remoteApiBase)) ||
    (llmText?.transport === "cloud-proxy" &&
      backend === "elizacloud" &&
      Boolean(llmText.smallModel?.trim() && llmText.largeModel?.trim())) ||
    (deploymentTarget.runtime === "remote" &&
      Boolean(deploymentTarget.remoteApiBase?.trim()));

  if (hasCompleteCanonicalRouting) {
    return true;
  }

  const agents = config.agents;
  if (!agents) {
    return false;
  }

  if (Array.isArray(agents.list) && agents.list.length > 0) {
    return true;
  }

  return Boolean(
    agents.defaults?.workspace?.trim() ||
      agents.defaults?.adminEntityId?.trim(),
  );
}

const APP_OWNER_NAME_MAX_LENGTH = 60;

/** Resolve the app owner's display name from config, or fall back to "User". */
export function resolveAppUserName(config: ElizaConfig): string {
  const ownerName = (config.ui as Record<string, unknown> | undefined)
    ?.ownerName as string | undefined;
  const normalized = ownerName?.trim().slice(0, APP_OWNER_NAME_MAX_LENGTH);
  return normalized || "User";
}

export function patchTouchesProviderSelection(
  patch: Record<string, unknown>,
): boolean {
  if (
    Object.hasOwn(patch, "cloud") ||
    Object.hasOwn(patch, "env") ||
    Object.hasOwn(patch, "models")
  ) {
    return true;
  }

  const agents =
    patch.agents &&
    typeof patch.agents === "object" &&
    !Array.isArray(patch.agents)
      ? (patch.agents as Record<string, unknown>)
      : null;
  const defaults =
    agents?.defaults &&
    typeof agents.defaults === "object" &&
    !Array.isArray(agents.defaults)
      ? (agents.defaults as Record<string, unknown>)
      : null;
  if (!defaults) {
    return false;
  }

  return (
    Object.hasOwn(defaults, "subscriptionProvider") ||
    Object.hasOwn(defaults, "model")
  );
}

// ---------------------------------------------------------------------------
// Conversation greeting
// ---------------------------------------------------------------------------

export function resolveConversationGreetingText(
  runtime: AgentRuntime,
  lang: string,
  uiConfig?: ElizaConfig["ui"],
): string {
  const pickRandom = (values: string[] | undefined): string => {
    const choices = (values ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (choices.length === 0) {
      return "";
    }

    return choices[Math.floor(Math.random() * choices.length)] ?? "";
  };

  const normalizedLanguage = normalizeCharacterLanguage(lang);
  const characterName = runtime.character.name?.trim();
  const assistantName = uiConfig?.assistant?.name?.trim();

  // Prefer explicit UI selections over the loaded character card: users pick a
  // style in onboarding/roster (avatar + preset) while `runtime.character.name`
  // can still reflect the bundled preset name until save/restart.
  const preset =
    resolveStylePresetByAvatarIndex(
      uiConfig?.avatarIndex,
      normalizedLanguage,
    ) ??
    resolveStylePresetById(uiConfig?.presetId, normalizedLanguage) ??
    resolveStylePresetByName(assistantName, normalizedLanguage) ??
    resolveStylePresetByName(characterName, normalizedLanguage);

  const presetGreeting = pickRandom(preset?.postExamples);
  if (presetGreeting) {
    return presetGreeting;
  }

  return pickRandom(runtime.character.postExamples);
}

// ---------------------------------------------------------------------------
// Package root resolution (for reading bundled plugins.json)
// ---------------------------------------------------------------------------

export function findOwnPackageRoot(startDir: string): string {
  const KNOWN_NAMES = new Set(["eliza", "eliza", "elizaos"]);
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<
          string,
          unknown
        >;
        const pkgName =
          typeof pkg.name === "string" ? pkg.name.toLowerCase() : "";
        if (KNOWN_NAMES.has(pkgName)) return dir;
        // Also match if plugins.json exists at this level (resilient to renames)
        if (fs.existsSync(path.join(dir, "plugins.json"))) return dir;
      } catch {
        /* keep searching */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
