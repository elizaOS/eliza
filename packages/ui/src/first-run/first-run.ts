/**
 * Deterministic first-run helpers shared by the in-chat onboarding conductor
 * and the headless finish path: draft normalization, runtime-target mapping,
 * submit validation, and the POST /api/first-run payload builder. Onboarding
 * is in-chat (#12178): there is no wizard step machine or persisted step/draft
 * state — onboarding state lives in the conductor's refs plus `firstRunComplete`.
 */

import {
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  getDefaultStylePreset,
} from "@elizaos/shared";
import type { UiLanguage } from "../i18n";
import {
  type BuildFirstRunRuntimeConfigResult,
  buildFirstRunRuntimeConfig,
} from "./first-run-config";
import type { FirstRunRuntimeTarget } from "./runtime-target";

export type FirstRunRuntime = "local" | "cloud" | "remote";

/**
 * When the user picks the Local runtime, this is the inference sub-choice:
 * - `all-local` runs every model on-device (kicks off model downloads now).
 * - `cloud-inference` keeps the agent local but routes inference through Eliza
 *   Cloud (maps to the `elizacloud-hybrid` server target).
 * - `configure-later` is the "bring your own keys / Other" path: the agent runs
 *   locally with NO model wired and NO local download — the user configures a
 *   provider (Anthropic sub / Codex / z.ai / Kimi) in Settings afterward. It is
 *   the one local sub-choice that leaves `needsProviderSetup` true so the finish
 *   path surfaces the "Open Settings" handoff.
 */
export type FirstRunLocalInference =
  | "all-local"
  | "cloud-inference"
  | "configure-later";

const FIRST_RUN_STATE_STORAGE_KEY = "eliza:first-run";

/** Default agent name when the user does not pick one (the first style preset). */
export const DEFAULT_AGENT_NAME = getDefaultStylePreset().name;

export interface FirstRunProfileDraft {
  agentName: string;
  runtime: FirstRunRuntime;
  localInference: FirstRunLocalInference;
  remoteApiBase: string;
  remoteToken: string;
}

export interface FirstRunSubmitPlan {
  payload: Record<string, unknown>;
  runtimeConfig: BuildFirstRunRuntimeConfigResult;
}

export interface FirstRunSubmitValidation {
  valid: boolean;
  message: string | null;
}

function trimmedOrDefault(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeFirstRunName(
  value: string | null | undefined,
): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

/** Drop the legacy wizard's persisted draft (old installs may still carry it). */
export function clearPersistedFirstRunState(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(FIRST_RUN_STATE_STORAGE_KEY);
  } catch {
    return;
  }
}

export function firstRunRuntimeTarget(
  runtime: FirstRunRuntime,
  localInference: FirstRunLocalInference = "all-local",
): FirstRunRuntimeTarget {
  if (runtime === "cloud") return "elizacloud";
  if (runtime === "remote") return "remote";
  return localInference === "cloud-inference" ? "elizacloud-hybrid" : "local";
}

/**
 * Whether the current runtime selection needs an Eliza Cloud connection before
 * setup can finish. True for the Cloud runtime and for Local + cloud-inference
 * (the hybrid, where the on-device agent routes inference through Eliza Cloud).
 * Drives the OAuth gate in the finish handlers, so the decision lives in one
 * place.
 */
export function firstRunNeedsCloudConnect(
  draft: Pick<FirstRunProfileDraft, "runtime" | "localInference">,
  elizaCloudConnected: boolean,
): boolean {
  if (elizaCloudConnected) return false;
  if (draft.runtime === "cloud") return true;
  return (
    draft.runtime === "local" && draft.localInference === "cloud-inference"
  );
}

/**
 * Whether finishing a Local runtime should kick off the on-device model
 * download. Only `all-local` pulls a local model; `cloud-inference` routes
 * inference through Eliza Cloud and must not download one.
 */
export function firstRunDownloadsLocalModel(
  localInference: FirstRunLocalInference,
): boolean {
  return localInference === "all-local";
}

function normalizeRemoteTarget(value: string): string {
  return value
    .trim()
    .replace(/\bdot\b/gi, ".")
    .replace(/\bslash\b/gi, "/")
    .replace(/\bcolon\b/gi, ":")
    .replace(/\s*:\s*\/\s*\//g, "://")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, "")
    .trim();
}

function looksLikeRemoteTarget(value: string): boolean {
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname.trim().length > 0
      );
    } catch {
      return false;
    }
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/.*)?$/i.test(
    value,
  );
}

export function validateFirstRunSubmitDraft(
  draft: FirstRunProfileDraft,
): FirstRunSubmitValidation {
  if (draft.runtime === "remote") {
    const remoteTarget = normalizeRemoteTarget(draft.remoteApiBase);
    if (!remoteTarget) {
      return {
        valid: false,
        message: "Enter the remote agent URL first.",
      };
    }
    if (!looksLikeRemoteTarget(remoteTarget)) {
      return {
        valid: false,
        message: "Enter a valid remote agent URL.",
      };
    }
  }
  return { valid: true, message: null };
}

export function buildFirstRunSubmitPlan(args: {
  draft: FirstRunProfileDraft;
  uiLanguage: UiLanguage;
}): FirstRunSubmitPlan {
  const style = getDefaultStylePreset(args.uiLanguage);
  const agentName = trimmedOrDefault(args.draft.agentName, style.name);
  const serverTarget = firstRunRuntimeTarget(
    args.draft.runtime,
    args.draft.localInference,
  );
  const cloudInference =
    args.draft.runtime === "cloud" || serverTarget === "elizacloud-hybrid";
  const runtimeConfig = buildFirstRunRuntimeConfig({
    firstRunRuntimeTarget: serverTarget,
    firstRunCloudApiKey: "",
    firstRunProvider: cloudInference ? "elizacloud" : "",
    firstRunApiKey: "",
    // Omit the runtime provider only when a provider is implicitly settled:
    // `all-local` (the on-device model IS the provider). `configure-later`
    // ("bring your own keys") deliberately does NOT omit, so no llmText route
    // is wired and `needsProviderSetup` stays true → the finish path opens
    // Settings. Cloud / cloud-inference wire `elizacloud` above, so this stays
    // behavior-preserving for them (they already have a route).
    omitRuntimeProvider: args.draft.localInference === "all-local",
    firstRunVoiceProvider: "",
    firstRunVoiceApiKey: "",
    firstRunPrimaryModel: "",
    firstRunOpenRouterModel: "",
    firstRunRemoteConnected: false,
    firstRunRemoteApiBase: args.draft.remoteApiBase,
    firstRunRemoteToken: args.draft.remoteToken,
    firstRunNanoModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    firstRunSmallModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    firstRunMediumModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    firstRunLargeModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    firstRunMegaModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    firstRunFeatureCrypto: true,
    firstRunFeatureBrowser: true,
  });
  const systemPrompt =
    style.system?.replace(/\{\{name\}\}/g, agentName) ??
    `You are ${agentName}, an autonomous AI agent powered by elizaOS.`;

  return {
    runtimeConfig,
    payload: {
      name: agentName,
      sandboxMode: args.draft.runtime === "cloud" ? "standard" : "off",
      bio: style.bio ?? ["An autonomous AI agent."],
      systemPrompt,
      style: style.style,
      adjectives: style.adjectives,
      topics: style.topics,
      postExamples: style.postExamples,
      messageExamples: style.messageExamples,
      avatarIndex: style.avatarIndex ?? 1,
      language: args.uiLanguage,
      presetId: style.id,
      deploymentTarget: runtimeConfig.deploymentTarget,
      ...(runtimeConfig.linkedAccounts
        ? { linkedAccounts: runtimeConfig.linkedAccounts }
        : {}),
      ...(runtimeConfig.serviceRouting
        ? { serviceRouting: runtimeConfig.serviceRouting }
        : {}),
      ...(runtimeConfig.credentialInputs
        ? { credentialInputs: runtimeConfig.credentialInputs }
        : {}),
      features: {
        crypto: { enabled: true },
        browser: { enabled: true },
        voice: { enabled: true, firstRun: true },
      },
    },
  };
}
