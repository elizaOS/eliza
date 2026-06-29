/**
 * Headless first-run use case (#9952, Phase 2).
 *
 * Presentation-free provisioning logic the in-chat onboarding conductor drives.
 * No React, no DOM rendering — every app setter / store action is supplied via
 * the injected {@link FirstRunPorts}, and progress is reported through
 * `onProgress` (the seam that replaces the controller's `setBusyText`). Each
 * entry point returns a {@link ConductorStep} the conductor renders as the next
 * synthetic assistant message (a prompt, a CHOICE marker, an OAuth secret card,
 * an error, or a terminal "done").
 *
 * The mechanics here are lifted from `use-first-run-controller.ts`
 * (`submitFirstRun` @590, `finishLocal` agent-start tail @646-716,
 * `finishCloudWithSelection` core @815-889). The shared on-device agent-start
 * primitives (`startLocalRuntime` / `waitForAgentApi`) are imported from the
 * controller rather than re-implemented. Logger only — no `console`.
 */

import { logger } from "@elizaos/logger";
import { client } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { getCloudAuthToken } from "../api/client-cloud";
import type { ConversationSecretRequest } from "../api/client-types-chat";
import type { CloudCompatAgent } from "../api/client-types-cloud";
import type { ChoiceOption } from "../components/chat/widgets/ChoiceWidget";
import { getBootConfig } from "../config/boot-config";
import type { UiLanguage } from "../i18n";
import type { Tab } from "../navigation";
import { isAndroid, isIOS } from "../platform/init";
import {
  addAgentProfile,
  createPersistedActiveServer,
  savePersistedActiveServer,
} from "../state";
import type { ActionBanner } from "../state/action-banner";
import type { AppActions } from "../state/types";
import { isCloudStatusAuthenticated, preOpenWindow } from "../utils";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";
import {
  buildFirstRunSubmitPlan,
  clearPersistedFirstRunState,
  type FirstRunProfileDraft,
  type FirstRunRuntime,
  firstRunDownloadsLocalModel,
  firstRunNeedsCloudConnect,
  firstRunRuntimeTarget,
} from "./first-run";
import { defaultProviderForRuntime } from "./first-run-config";
import {
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeModeForServerTarget,
} from "./mobile-runtime-mode";
import { startLocalRuntime, waitForAgentApi } from "./use-first-run-controller";
import { resolveFirstRunLocalAgentApiBase } from "./voice-readiness";

// ── Ports ──────────────────────────────────────────────────────────────────

/** Subset of the app store the use case mutates, all injected (no React). */
export interface FirstRunPorts {
  uiLanguage: UiLanguage;
  /** Latest known Eliza Cloud connection state at call time. */
  elizaCloudConnected: boolean;
  setState: AppActions["setState"];
  handleCloudLogin: (prePoppedWindow?: Window | null) => Promise<void>;
  completeFirstRun: AppActions["completeFirstRun"];
  showActionBanner: (banner: ActionBanner) => void;
  setTab: (tab: Tab) => void;
  startTutorial: () => void;
  /** Replaces the controller's `setBusyText`. `null` clears the indicator. */
  onProgress: (text: string | null) => void;
}

// ── Conductor step contract ──────────────────────────────────────────────────

/** A first-run-scoped CHOICE the conductor renders via the CHOICE marker. */
export interface ChoiceSpec {
  scope: "first-run";
  id: "runtime" | "provider" | "agent" | "tutorial";
  allowCustom?: boolean;
  options: ChoiceOption[];
}

export type ConductorStep =
  | { kind: "prompt"; text: string }
  | { kind: "choice"; text: string; choice: ChoiceSpec }
  | { kind: "secret"; text: string; secretRequest: ConversationSecretRequest }
  | { kind: "error"; text: string; choice?: ChoiceSpec }
  | { kind: "done"; text?: string };

/** Either reuse/prefer a known agent id, or force a brand-new agent. */
export type CloudAgentSelection =
  | { preferAgentId?: string | null }
  | { forceCreate: true };

// ── Internal shared mechanics ────────────────────────────────────────────────

function isHttpLoopbackBase(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function shouldUseAppShellLocalAgentProxy(apiBase: string): boolean {
  if (!isHttpLoopbackBase(apiBase)) return false;
  if (typeof window === "undefined") return false;
  const { origin, protocol } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return false;
  try {
    return new URL(apiBase).origin !== origin;
  } catch {
    return false;
  }
}

function localAgentClientBase(apiBase: string): string | null {
  return shouldUseAppShellLocalAgentProxy(apiBase) ? null : apiBase;
}

function localAgentFetchBase(apiBase: string): string {
  return shouldUseAppShellLocalAgentProxy(apiBase) &&
    typeof window !== "undefined"
    ? window.location.origin
    : apiBase;
}

function shouldSubmitFirstRunViaAppShellOrigin(
  runtime: FirstRunRuntime,
  baseUrl: string,
): boolean {
  if (runtime !== "local") return false;
  return shouldUseAppShellLocalAgentProxy(baseUrl);
}

function canProbeCloudStatus(): boolean {
  const baseUrl =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl().trim() : "";
  if (!supportsFullAppShellRoutes(baseUrl)) return false;
  if (baseUrl) return true;
  if (typeof window !== "undefined" && window.location.port === "2138") {
    return false;
  }
  return true;
}

async function getCloudStatusIfSupported() {
  if (!canProbeCloudStatus()) return null;
  return client.getCloudStatus().catch(() => null);
}

function readSyncOnDeviceAgentBearer(): string | null {
  try {
    const bridge = (
      globalThis as typeof globalThis & {
        ElizaNative?: { getLocalAgentToken?: () => string | null };
      }
    ).ElizaNative;
    const token = bridge?.getLocalAgentToken?.();
    if (typeof token !== "string") return null;
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** The single `POST /api/first-run` — server sets `meta.firstRunComplete`. */
export async function submitFirstRunProfile(
  ports: FirstRunPorts,
  draft: FirstRunProfileDraft,
  runtime: FirstRunRuntime,
): Promise<void> {
  const plan = buildFirstRunSubmitPlan({
    draft: { ...draft, runtime },
    uiLanguage: ports.uiLanguage,
  });
  const currentBase =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
  if (shouldSubmitFirstRunViaAppShellOrigin(runtime, currentBase.trim())) {
    client.setBaseUrl(null);
    try {
      await client.submitFirstRun(plan.payload);
    } finally {
      client.setBaseUrl(currentBase || null);
    }
  } else {
    await client.submitFirstRun(plan.payload);
  }
  if (plan.runtimeConfig.needsProviderSetup) {
    ports.showActionBanner({
      text: "Choose a model provider in Settings before sending the first message.",
      actionLabel: "Open Settings",
      onAction: () => ports.setTab("settings"),
    });
  }
}

/**
 * Resolve the Eliza Cloud connection: true when already connected (or a session
 * token is present), otherwise run the in-app Steward sign-in and re-probe.
 * Mirrors the controller's OAuth gate (`finishCloud` @1010-1044).
 */
async function resolveCloudConnection(ports: FirstRunPorts): Promise<boolean> {
  let connected = ports.elizaCloudConnected;
  if (!connected) {
    const status = await getCloudStatusIfSupported();
    connected = isCloudStatusAuthenticated(
      Boolean(status?.connected),
      status?.reason,
    );
  }
  if (connected) return true;

  const authWindow = preOpenWindow();
  await ports.handleCloudLogin(authWindow);
  const status = await getCloudStatusIfSupported();
  connected = isCloudStatusAuthenticated(
    Boolean(status?.connected),
    status?.reason,
  );
  // A present session token is authoritative even if the status proxy lags.
  if (!connected && getCloudAuthToken(client)) connected = true;
  return connected;
}

// ── Use-case entry points ────────────────────────────────────────────────────

/** Route the runtime CHOICE pick. */
export async function runFirstRunRuntimeChoice(
  ports: FirstRunPorts,
  value: "cloud" | "local" | "other",
  draft: FirstRunProfileDraft,
): Promise<ConductorStep> {
  switch (value) {
    case "cloud":
      return beginCloudOAuth(ports, draft);
    case "local":
      return providerChoiceStep("local");
    case "other":
      return routeOtherToSettings(ports);
  }
}

/** The provider sub-choice with the role-correct default pre-highlighted. */
function providerChoiceStep(runtime: FirstRunRuntime): ConductorStep {
  const preferred = defaultProviderForRuntime(runtime);
  const options: ChoiceOption[] = [
    { value: "provider:on-device", label: "On-device (everything local)" },
    { value: "provider:elizacloud", label: "Eliza Cloud inference" },
  ];
  const text =
    preferred === "elizacloud"
      ? "How should I think? Eliza Cloud is recommended for this setup."
      : "How should I think? On-device keeps everything on this machine.";
  return {
    kind: "choice",
    text,
    choice: { scope: "first-run", id: "provider", options },
  };
}

/**
 * Cloud runtime entry. When not yet connected, run the OAuth gate; when
 * connected, offer the agent picker (≥1 existing agents) or auto-provision (0).
 */
export async function beginCloudOAuth(
  ports: FirstRunPorts,
  draft: FirstRunProfileDraft,
): Promise<ConductorStep> {
  ports.setState("firstRunRuntimeTarget", firstRunRuntimeTarget("cloud"));
  ports.setState("firstRunProvider", "elizacloud");

  const connected = await resolveCloudConnection(ports);
  if (!connected) {
    return {
      kind: "error",
      text: "I couldn't reach Eliza Cloud sign-in. Want to try again?",
      choice: {
        scope: "first-run",
        id: "runtime",
        allowCustom: true,
        options: [
          { value: "cloud", label: "Retry Eliza Cloud" },
          { value: "local", label: "Run locally instead" },
          { value: "other", label: "Something else…" },
        ],
      },
    };
  }

  const authToken = getCloudAuthToken(client);
  if (!authToken) {
    return {
      kind: "error",
      text: "Signed in, but I couldn't read your Cloud token. Want to try again?",
      choice: {
        scope: "first-run",
        id: "runtime",
        options: [{ value: "cloud", label: "Retry Eliza Cloud" }],
      },
    };
  }

  const listed = await client.getCloudCompatAgents().catch(() => ({
    success: false,
    data: [] as CloudCompatAgent[],
  }));
  const agents = listed.success ? listed.data : [];
  if (agents.length === 0) {
    return completeCloudProvisioning(ports, draft, { preferAgentId: null });
  }

  const options: ChoiceOption[] = [
    ...agents.map((agent) => ({
      value: `agent:${agent.agent_id}`,
      label: agent.agent_name || agent.agent_id,
    })),
    { value: "agent:new", label: "Create a new agent" },
  ];
  return {
    kind: "choice",
    text: "Welcome back — which agent should I run?",
    choice: { scope: "first-run", id: "agent", options },
  };
}

/**
 * Provision (or reuse) the cloud agent, persist it, submit the profile once.
 * Lifted from `finishCloudWithSelection` @815-889. The shared→dedicated
 * background handoff (controller @906-999, gated on `preferSharedCloudTier`)
 * stays in the legacy controller for now and is not part of this entry point.
 */
export async function completeCloudProvisioning(
  ports: FirstRunPorts,
  draft: FirstRunProfileDraft,
  selection: CloudAgentSelection,
): Promise<ConductorStep> {
  ports.onProgress("Setting up your cloud agent");
  const plan = buildFirstRunSubmitPlan({
    draft: { ...draft, runtime: "cloud" },
    uiLanguage: ports.uiLanguage,
  });
  const name =
    typeof plan.payload.name === "string" ? plan.payload.name : "Eliza";
  const bio = Array.isArray(plan.payload.bio)
    ? plan.payload.bio.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : ["An autonomous AI agent."];

  const authToken = getCloudAuthToken(client) ?? "";
  const preferAgentId =
    "preferAgentId" in selection ? selection.preferAgentId : undefined;
  const forceCreate =
    "forceCreate" in selection ? selection.forceCreate : false;

  const selectedAgent = await client.selectOrProvisionCloudAgent({
    cloudApiBase: getBootConfig().cloudApiBase || "https://www.elizacloud.ai",
    authToken,
    name,
    bio,
    ...(preferAgentId ? { preferAgentId } : {}),
    ...(forceCreate ? { forceCreate: true } : {}),
    ...(getBootConfig().preferSharedCloudTier
      ? { preferSharedTier: true }
      : {}),
    onProgress: (status, detail) => ports.onProgress(detail ?? status),
  });
  const cloudAgentApiBase = selectedAgent.apiBase;
  client.setBaseUrl(cloudAgentApiBase);
  client.setToken(authToken);
  const activeServer = createPersistedActiveServer({
    kind: "cloud",
    id: `cloud:${selectedAgent.agentId}`,
    apiBase: cloudAgentApiBase,
    accessToken: authToken,
  });
  savePersistedActiveServer(activeServer);
  addAgentProfile({
    kind: "cloud",
    label: activeServer.label,
    ...(activeServer.apiBase ? { apiBase: activeServer.apiBase } : {}),
    ...(activeServer.accessToken
      ? { accessToken: activeServer.accessToken }
      : {}),
  });
  persistMobileRuntimeModeForServerTarget("elizacloud");
  ports.onProgress("Saving first-run profile");
  if (supportsFullAppShellRoutes(cloudAgentApiBase)) {
    await client.submitFirstRun(plan.payload);
  }
  clearPersistedFirstRunState();
  ports.onProgress(null);
  logger.info("[FirstRunUseCase] cloud agent provisioned");
  return { kind: "done", text: "Your cloud agent is ready." };
}

/** Provider sub-choice → set inference mode → (hybrid: connect cloud) → local. */
export async function chooseProvider(
  ports: FirstRunPorts,
  draft: FirstRunProfileDraft,
  providerId: "on-device" | "elizacloud",
): Promise<ConductorStep> {
  const localInference =
    providerId === "elizacloud" ? "cloud-inference" : "all-local";
  const nextDraft: FirstRunProfileDraft = { ...draft, localInference };

  if (firstRunNeedsCloudConnect(nextDraft, ports.elizaCloudConnected)) {
    ports.setState("firstRunRuntimeTarget", "elizacloud-hybrid");
    ports.setState("firstRunProvider", "elizacloud");
    const connected = await resolveCloudConnection(ports);
    if (!connected) {
      return {
        kind: "error",
        text: "I couldn't connect Eliza Cloud for hybrid inference. Want to try again?",
        choice: {
          scope: "first-run",
          id: "provider",
          options: [
            { value: "provider:elizacloud", label: "Retry Eliza Cloud" },
            { value: "provider:on-device", label: "Run fully on-device" },
          ],
        },
      };
    }
  }
  return runLocalSetup(ports, nextDraft);
}

/**
 * Start + await the on-device agent, persist it, submit the profile once.
 * Lifted from `finishLocal` agent-start tail @646-716.
 */
export async function runLocalSetup(
  ports: FirstRunPorts,
  draft: FirstRunProfileDraft,
): Promise<ConductorStep> {
  const serverTarget = firstRunRuntimeTarget(
    draft.runtime,
    draft.localInference,
  );
  persistMobileRuntimeModeForServerTarget(serverTarget);
  ports.setState("firstRunRuntimeTarget", serverTarget);
  ports.onProgress("Starting local agent");
  const apiBase = resolveFirstRunLocalAgentApiBase();
  const clientBase = localAgentClientBase(apiBase);
  client.setBaseUrl(clientBase);
  client.setToken(isAndroid || isIOS ? readSyncOnDeviceAgentBearer() : null);
  await startLocalRuntime();
  await waitForAgentApi();
  if (isAndroid || isIOS) {
    savePersistedActiveServer({
      id: isAndroid
        ? ANDROID_LOCAL_AGENT_SERVER_ID
        : MOBILE_LOCAL_AGENT_SERVER_ID,
      kind: "remote",
      label: isAndroid ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
      apiBase,
    });
    addAgentProfile({
      kind: "remote",
      label: isAndroid ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
      apiBase,
    });
  } else if (clientBase) {
    savePersistedActiveServer({
      id: "local:desktop",
      kind: "remote",
      label: "Local agent",
      apiBase: clientBase,
    });
    addAgentProfile({
      kind: "remote",
      label: "Local agent",
      apiBase: clientBase,
    });
  } else {
    savePersistedActiveServer({
      id: "local:app-shell",
      kind: "local",
      label: "Local agent",
    });
    addAgentProfile({ kind: "local", label: "Local agent" });
  }
  ports.onProgress("Saving first-run profile");
  await submitFirstRunProfile(ports, draft, "local");
  if (firstRunDownloadsLocalModel(draft.localInference)) {
    void autoDownloadRecommendedLocalModelInBackground(
      localAgentFetchBase(apiBase),
    );
  }
  clearPersistedFirstRunState();
  ports.onProgress(null);
  logger.info("[FirstRunUseCase] local agent started + profile saved");
  return { kind: "done", text: "Your local agent is ready." };
}

/** "Something else" → hand off to Settings and finish first-run there. */
export function routeOtherToSettings(ports: FirstRunPorts): ConductorStep {
  ports.setTab("settings");
  ports.completeFirstRun("settings");
  logger.info("[FirstRunUseCase] routed to settings handoff");
  return {
    kind: "prompt",
    text: "No problem — I've opened Settings so you can configure things your way.",
  };
}

/** Post-provision tutorial-or-skip resolution. */
export function finalizeFirstRun(
  ports: FirstRunPorts,
  takeTutorial: boolean,
): void {
  ports.completeFirstRun("chat", { launchCompanionOverlay: true });
  if (takeTutorial) ports.startTutorial();
  logger.info(
    `[FirstRunUseCase] first-run finalized (tutorial=${takeTutorial})`,
  );
}
