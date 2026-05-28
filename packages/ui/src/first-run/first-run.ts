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

export type FirstRunStep = "runtime" | "remote";
export type FirstRunRuntime = "local" | "cloud" | "remote";

export const FIRST_RUN_STEPS: readonly FirstRunStep[] = [
  "runtime",
  "remote",
] as const;

const FIRST_RUN_STATE_STORAGE_KEY = "eliza:first-run";

/** Default agent name when the user does not pick one (the first style preset). */
export const DEFAULT_AGENT_NAME = getDefaultStylePreset().name;

export interface FirstRunProfileDraft {
  agentName: string;
  runtime: FirstRunRuntime;
  remoteApiBase: string;
  remoteToken: string;
  useLocalEmbeddings: boolean;
}

export type FirstRunDraftUpdate = <K extends keyof FirstRunProfileDraft>(
  key: K,
  value: FirstRunProfileDraft[K],
) => void;

export interface FirstRunSubmitPlan {
  payload: Record<string, unknown>;
  runtimeConfig: BuildFirstRunRuntimeConfigResult;
}

export type FirstRunVoiceAction = "none" | "finish";

export interface FirstRunVoiceUpdate {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
  action: FirstRunVoiceAction;
}

export interface PersistedFirstRunState {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
}

export interface FirstRunSubmitValidation {
  valid: boolean;
  step: FirstRunStep;
  message: string | null;
}

function trimmedOrDefault(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeFirstRunName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isFirstRunStep(value: unknown): value is FirstRunStep {
  return value === "runtime" || value === "remote";
}

function isFirstRunRuntime(value: unknown): value is FirstRunRuntime {
  return value === "local" || value === "cloud" || value === "remote";
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readBooleanField(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === true;
}

function normalizePersistedDraft(
  value: unknown,
  fallback: FirstRunProfileDraft,
): FirstRunProfileDraft {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  return {
    agentName:
      readStringField(record, "agentName") ||
      normalizeFirstRunName(fallback.agentName) ||
      DEFAULT_AGENT_NAME,
    runtime: isFirstRunRuntime(record.runtime)
      ? record.runtime
      : fallback.runtime,
    remoteApiBase: readStringField(record, "remoteApiBase"),
    remoteToken: readStringField(record, "remoteToken"),
    useLocalEmbeddings: readBooleanField(record, "useLocalEmbeddings"),
  };
}

export function loadPersistedFirstRunState(
  fallbackDraft: FirstRunProfileDraft,
): PersistedFirstRunState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FIRST_RUN_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      step: isFirstRunStep(parsed.step) ? parsed.step : "runtime",
      draft: normalizePersistedDraft(parsed.draft, fallbackDraft),
    };
  } catch {
    return null;
  }
}

export function savePersistedFirstRunState(
  state: PersistedFirstRunState,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      FIRST_RUN_STATE_STORAGE_KEY,
      JSON.stringify(state),
    );
  } catch {
    return;
  }
}

export function clearPersistedFirstRunState(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(FIRST_RUN_STATE_STORAGE_KEY);
  } catch {
    return;
  }
}

export function nextFirstRunStep(step: FirstRunStep): FirstRunStep | null {
  const index = FIRST_RUN_STEPS.indexOf(step);
  if (index < 0) return "runtime";
  return FIRST_RUN_STEPS[index + 1] ?? null;
}

export function previousFirstRunStep(step: FirstRunStep): FirstRunStep | null {
  const index = FIRST_RUN_STEPS.indexOf(step);
  if (index <= 0) return null;
  return FIRST_RUN_STEPS[index - 1] ?? null;
}

export function firstRunRuntimeTarget(
  runtime: FirstRunRuntime,
): FirstRunRuntimeTarget {
  if (runtime === "cloud") return "elizacloud";
  if (runtime === "remote") return "remote";
  return "local";
}

function stripFirstRunVoicePrefix(value: string): string {
  return value
    .trim()
    .replace(/^(?:hey\s+)?(?:milady|eliza)\b[\s,.:;!-]*/i, "")
    .trim();
}

function normalizeFirstRunVoiceCommand(value: string): string {
  return stripFirstRunVoicePrefix(value)
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasFinishCommand(command: string): boolean {
  return /\b(?:start|launch|continue|connect|finish|run)\b/.test(command);
}

function normalizeSpokenRemoteTarget(value: string): string {
  return stripFirstRunVoicePrefix(value)
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
  return (
    /^https?:\/\//i.test(value) ||
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/.*)?$/i.test(
      value,
    )
  );
}

export function applyFirstRunVoiceTranscript(args: {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
  transcript: string;
}): FirstRunVoiceUpdate {
  const spoken = stripFirstRunVoicePrefix(args.transcript);
  const command = normalizeFirstRunVoiceCommand(args.transcript);
  const draft = { ...args.draft };

  if (!spoken || !command) {
    return { step: args.step, draft, action: "none" };
  }

  if (args.step === "runtime") {
    if (/\b(?:remote|api|server|existing)\b/.test(command)) {
      draft.runtime = "remote";
      return { step: "remote", draft, action: "none" };
    }
    if (/\b(?:cloud|elizacloud|eliza cloud)\b/.test(command)) {
      draft.runtime = "cloud";
      return {
        step: "runtime",
        draft,
        action: hasFinishCommand(command) ? "finish" : "none",
      };
    }
    if (/\b(?:local|this computer|this device|bundled)\b/.test(command)) {
      draft.runtime = "local";
      return {
        step: "runtime",
        draft,
        action: hasFinishCommand(command) ? "finish" : "none",
      };
    }
    return {
      step: "runtime",
      draft,
      action: hasFinishCommand(command) ? "finish" : "none",
    };
  }

  const tokenMatch = spoken.match(/^(?:token|access token|use token)\s+(.+)$/i);
  if (tokenMatch) {
    draft.remoteToken = tokenMatch[1]?.trim() ?? "";
    return {
      step: "remote",
      draft,
      action:
        hasFinishCommand(command) && draft.remoteApiBase ? "finish" : "none",
    };
  }

  const remoteTarget = normalizeSpokenRemoteTarget(spoken);
  if (looksLikeRemoteTarget(remoteTarget)) {
    draft.remoteApiBase = remoteTarget;
    return { step: "remote", draft, action: "none" };
  }

  return {
    step: "remote",
    draft,
    action:
      hasFinishCommand(command) && draft.remoteApiBase ? "finish" : "none",
  };
}

export function validateFirstRunSubmitDraft(
  draft: FirstRunProfileDraft,
): FirstRunSubmitValidation {
  if (
    draft.runtime === "remote" &&
    !normalizeSpokenRemoteTarget(draft.remoteApiBase)
  ) {
    return {
      valid: false,
      step: "remote",
      message: "Enter the remote agent URL first.",
    };
  }
  return { valid: true, step: "runtime", message: null };
}

export function isFirstRunPromptEcho(args: {
  promptText: string;
  transcript: string;
}): boolean {
  const prompt = normalizeFirstRunVoiceCommand(args.promptText);
  const transcript = normalizeFirstRunVoiceCommand(args.transcript);
  if (prompt.length < 12 || transcript.length < 12) return false;
  return prompt === transcript || prompt.includes(transcript);
}

export function buildFirstRunSubmitPlan(args: {
  draft: FirstRunProfileDraft;
  uiLanguage: UiLanguage;
}): FirstRunSubmitPlan {
  const style = getDefaultStylePreset(args.uiLanguage);
  const agentName = trimmedOrDefault(args.draft.agentName, style.name);
  const serverTarget = firstRunRuntimeTarget(args.draft.runtime);
  const runtimeConfig = buildFirstRunRuntimeConfig({
    firstRunRuntimeTarget: serverTarget,
    firstRunCloudApiKey: "",
    firstRunProvider: args.draft.runtime === "cloud" ? "elizacloud" : "",
    firstRunApiKey: "",
    omitRuntimeProvider: args.draft.runtime !== "cloud",
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
    firstRunUseLocalEmbeddings: args.draft.useLocalEmbeddings,
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
