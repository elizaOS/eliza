// ============================================================================
// Headless first-run "finish" use case.
//
// This is the SINGLE provisioning implementation for completing onboarding.
// It owns no presentation — the in-chat first-run conductor
// (`use-first-run-conductor.ts`) calls these functions and renders the seeded
// chat messages. All product decisions (default provider, needsProviderSetup,
// the POST body) live in the pure config layer (`first-run-config.ts` /
// `first-run.ts`); this module wires the ports.
//
// Extracted from the former `use-first-run-controller.ts` React hook (the
// full-screen onboarding wizard, now deleted). The finish bodies are moved
// here verbatim apart from replacing React state/setters with injected ports
// and funneling EVERY `POST /api/first-run` through the single `persistFirstRun`
// helper (idempotency-guarded), so a completed onboarding posts exactly once.
// ============================================================================

import { client } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import {
  getCloudAuthToken,
  isDirectCloudSharedAgentBase,
} from "../api/client-cloud";
import type { CloudCompatAgent } from "../api/client-types-cloud";
import { getDesktopRuntimeMode, invokeDesktopBridgeRequest } from "../bridge";
import { type AgentPluginLike, getAgentPlugin } from "../bridge/native-plugins";
import { savePendingCloudHandoff } from "../cloud/handoff/pending-handoff-store";
import { runCloudAgentHandoff } from "../cloud/handoff/run-cloud-agent-handoff";
import { silentlyRepointToDedicated } from "../cloud/handoff/silent-repoint";
import { getBootConfig } from "../config/boot-config";
import type { UiLanguage } from "../i18n";
import { isAndroid, isDesktopPlatform, isIOS } from "../platform/init";
import {
  addAgentProfile,
  createPersistedActiveServer,
  loadPersistedActiveServer,
  removeAgentProfile,
  savePersistedActiveServer,
} from "../state";
import type { ActionBanner } from "../state/action-banner";
import { isCloudStatusAuthenticated } from "../utils";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";
import {
  buildFirstRunSubmitPlan,
  clearPersistedFirstRunState,
  type FirstRunProfileDraft,
  type FirstRunRuntime,
  firstRunDownloadsLocalModel,
  firstRunNeedsCloudConnect,
  firstRunRuntimeTarget,
  normalizeFirstRunName,
  validateFirstRunSubmitDraft,
} from "./first-run";
import {
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeModeForServerTarget,
} from "./mobile-runtime-mode";
import { resolveFirstRunLocalAgentApiBase } from "./runtime-target";

const FIRST_RUN_AGENT_WAIT_MS = 180_000;

// ── Injected ports — the store seams the finish logic needs ──────────────────

export interface FirstRunFinishPorts {
  uiLanguage: UiLanguage;
  elizaCloudConnected: boolean;
  handleCloudLogin: (prePoppedWindow?: Window | null) => Promise<void>;
  /** Pre-opened popup window for the cloud-login redirect (popup-blocker safe). */
  preOpenWindow?: () => Window | null;
  setRuntimeState: (
    key: FirstRunRuntimeStateKey,
    value: string | boolean,
  ) => void;
  showActionBanner: (banner: ActionBanner) => void;
  setTab: (tab: string) => void;
  /** Injected client-side finalizer (flips firstRunComplete; never POSTs). */
  completeFirstRun: (landingTab?: string) => void;
  /** Status text (e.g. "Starting local agent") surfaced into the chat transcript. */
  onStatus?: (text: string | null) => void;
}

type FirstRunRuntimeStateKey =
  | "firstRunRuntimeTarget"
  | "firstRunProvider"
  | "firstRunRemoteApiBase"
  | "firstRunRemoteToken"
  | "firstRunRemoteConnected"
  | "firstRunName";

// ── Finish outcomes — translated by the conductor into seeded chat turns ─────

export type FirstRunFinishOutcome =
  | { kind: "done" }
  | { kind: "needs-cloud-login"; fallbackUrl?: string }
  | { kind: "pick-cloud-agent"; agents: CloudCompatAgent[] }
  | { kind: "error"; message: string };

// ── Exactly-once POST funnel ─────────────────────────────────────────────────

let firstRunPersisted = false;
let firstRunPersistInFlight: Promise<void> | null = null;

/** Reset the once-only guard (tests + a fresh re-entry into onboarding). */
export function resetFirstRunPersistGuard(): void {
  firstRunPersisted = false;
  firstRunPersistInFlight = null;
}

/**
 * The SOLE call site of `client.submitFirstRun` (= POST /api/first-run). Local
 * always persists once; cloud persists once iff the bound cloud agent host
 * owns the app-shell routes. The module-scoped guard plus the server-side
 * `meta.firstRunComplete` make a re-tapped first-run choice idempotent, and
 * concurrent callers (double-fired finishes) share one in-flight POST instead
 * of racing past the completed flag.
 */
async function persistFirstRun(
  plan: ReturnType<typeof buildFirstRunSubmitPlan>,
  ports: FirstRunFinishPorts,
  opts: { viaAppShellOrigin?: boolean } = {},
): Promise<void> {
  if (firstRunPersisted) return;
  if (!firstRunPersistInFlight) {
    firstRunPersistInFlight = (async () => {
      if (opts.viaAppShellOrigin) {
        const currentBase =
          typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
        client.setBaseUrl(null);
        try {
          await client.submitFirstRun(plan.payload);
        } finally {
          client.setBaseUrl(currentBase || null);
        }
      } else {
        await client.submitFirstRun(plan.payload);
      }
      firstRunPersisted = true;
      if (plan.runtimeConfig.needsProviderSetup) {
        ports.showActionBanner({
          text: "Choose a model provider in Settings before sending the first message.",
          actionLabel: "Open Settings",
          onAction: () => ports.setTab("settings"),
        });
      }
    })().finally(() => {
      firstRunPersistInFlight = null;
    });
  }
  await firstRunPersistInFlight;
}

// ── Module helpers (moved from the controller) ───────────────────────────────

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

function shouldSubmitFirstRunViaAppShellOrigin(
  runtime: FirstRunRuntime,
  baseUrl: string,
): boolean {
  if (runtime !== "local") return false;
  return shouldUseAppShellLocalAgentProxy(baseUrl);
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

async function startMobileLocalAgent(): Promise<void> {
  if (!isAndroid && !isIOS) return;
  try {
    await getAgentPlugin().start?.({
      apiBase: resolveFirstRunLocalAgentApiBase(),
      mode: "local",
    });
  } catch {
    const agentPluginId = "@elizaos/capacitor-agent";
    const { Agent } = await import(/* @vite-ignore */ agentPluginId);
    await (Agent as AgentPluginLike | undefined)?.start?.({
      apiBase: resolveFirstRunLocalAgentApiBase(),
      mode: "local",
    });
  }
}

async function startLocalRuntime(): Promise<void> {
  if (isDesktopPlatform()) {
    try {
      const desktopRuntimeMode = await getDesktopRuntimeMode().catch(
        () => null,
      );
      if (desktopRuntimeMode && desktopRuntimeMode.mode !== "local") {
        return;
      }
      await invokeDesktopBridgeRequest({
        rpcMethod: "agentStart",
        ipcChannel: "agent:start",
      });
      return;
    } catch (error) {
      try {
        await client.getAuthStatus();
        return;
      } catch {
        throw error;
      }
    }
  }
  await startMobileLocalAgent();
}

async function waitForAgentApi(): Promise<void> {
  const deadline = Date.now() + FIRST_RUN_AGENT_WAIT_MS;
  let delayMs = 750;
  while (Date.now() < deadline) {
    try {
      await client.getAuthStatus();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.35), 4_000);
    }
  }
  throw new Error(
    "The agent API did not become ready before the first-run deadline.",
  );
}

/**
 * Newest-first, running-prioritized order — mirrors pickPreferredCloudAgent
 * (client-cloud.ts) so the picker's top-of-list matches the silent auto-default.
 */
function sortCloudAgentsForPicker(
  agents: CloudCompatAgent[],
): CloudCompatAgent[] {
  return [...agents]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .sort((a, b) => {
      const aRunning = a.status === "running" ? 0 : 1;
      const bRunning = b.status === "running" ? 0 : 1;
      return aRunning - bRunning;
    });
}

function syncIdentity(
  sourceDraft: FirstRunProfileDraft,
  ports: FirstRunFinishPorts,
): void {
  const agentName = normalizeFirstRunName(sourceDraft.agentName);
  if (agentName) {
    ports.setRuntimeState("firstRunName", agentName);
  }
}

// ── Local runtime finish ─────────────────────────────────────────────────────

async function finishLocal(
  sourceDraft: FirstRunProfileDraft,
  ports: FirstRunFinishPorts,
): Promise<FirstRunFinishOutcome> {
  syncIdentity(sourceDraft, ports);
  // Local + cloud-inference (hybrid) routes inference through Eliza Cloud, so
  // connect the cloud account first.
  if (firstRunNeedsCloudConnect(sourceDraft, ports.elizaCloudConnected)) {
    ports.setRuntimeState("firstRunRuntimeTarget", "elizacloud-hybrid");
    ports.setRuntimeState("firstRunProvider", "elizacloud");
    const authWindow = ports.preOpenWindow?.() ?? null;
    await ports.handleCloudLogin(authWindow);
    const cloudStatus = await getCloudStatusIfSupported();
    let cloudConnectedForFinish = isCloudStatusAuthenticated(
      Boolean(cloudStatus?.connected),
      cloudStatus?.reason,
    );
    if (!cloudConnectedForFinish && getCloudAuthToken(client)) {
      cloudConnectedForFinish = true;
    }
    if (!cloudConnectedForFinish) {
      return { kind: "needs-cloud-login" };
    }
  }
  const serverTarget = firstRunRuntimeTarget(
    sourceDraft.runtime,
    sourceDraft.localInference,
  );
  persistMobileRuntimeModeForServerTarget(serverTarget);
  ports.setRuntimeState("firstRunRuntimeTarget", serverTarget);
  ports.onStatus?.("Starting local agent");
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
  ports.onStatus?.("Saving first-run profile");
  const plan = buildFirstRunSubmitPlan({
    draft: { ...sourceDraft, runtime: "local" },
    uiLanguage: ports.uiLanguage,
  });
  const currentBase =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "";
  await persistFirstRun(plan, ports, {
    viaAppShellOrigin: shouldSubmitFirstRunViaAppShellOrigin(
      "local",
      currentBase.trim(),
    ),
  });
  if (firstRunDownloadsLocalModel(sourceDraft.localInference)) {
    void autoDownloadRecommendedLocalModelInBackground(
      localAgentFetchBase(apiBase),
    );
  }
  clearPersistedFirstRunState();
  ports.onStatus?.(null);
  ports.completeFirstRun("chat");
  return { kind: "done" };
}

// ── Cloud runtime finish ─────────────────────────────────────────────────────

/**
 * The provisioning tail of the cloud flow — both the silent auto-create path (0
 * agents) and the picker's pick / create-new feed their choice
 * (preferAgentId / forceCreate) into the SAME provisioning call.
 */
export async function bindCloudAgent(
  sourceDraft: FirstRunProfileDraft,
  authToken: string,
  opts: { preferAgentId?: string | null; forceCreate?: boolean },
  ports: FirstRunFinishPorts,
): Promise<FirstRunFinishOutcome> {
  ports.onStatus?.("Setting up your cloud agent");
  const plan = buildFirstRunSubmitPlan({
    draft: { ...sourceDraft, runtime: "cloud" },
    uiLanguage: ports.uiLanguage,
  });
  const name =
    typeof plan.payload.name === "string" ? plan.payload.name : "Eliza";
  const bio = Array.isArray(plan.payload.bio)
    ? plan.payload.bio.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : ["An autonomous AI agent."];
  const selectedAgent = await client.selectOrProvisionCloudAgent({
    cloudApiBase: getBootConfig().cloudApiBase || "https://elizacloud.ai",
    authToken,
    name,
    bio,
    ...(opts.preferAgentId ? { preferAgentId: opts.preferAgentId } : {}),
    ...(opts.forceCreate ? { forceCreate: true } : {}),
    ...(getBootConfig().preferSharedCloudTier
      ? { preferSharedTier: true }
      : {}),
    onProgress: (status, detail) => ports.onStatus?.(detail ?? status),
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
  const sharedAgentProfile = addAgentProfile({
    kind: "cloud",
    label: activeServer.label,
    ...(activeServer.apiBase ? { apiBase: activeServer.apiBase } : {}),
    ...(activeServer.accessToken
      ? { accessToken: activeServer.accessToken }
      : {}),
  });
  persistMobileRuntimeModeForServerTarget("elizacloud");
  ports.onStatus?.("Saving first-run profile");
  // Direct Cloud agent bases are chat runtimes, not full app-shell setup
  // servers — they do not own /api/first-run. Only persist when the bound base
  // owns the app-shell routes.
  if (supportsFullAppShellRoutes(cloudAgentApiBase)) {
    await persistFirstRun(plan, ports);
  }
  clearPersistedFirstRunState();
  ports.onStatus?.(null);
  ports.completeFirstRun("chat");

  // Seamless shared→dedicated cloud-agent handoff (background). Flag OFF →
  // `selectedAgent` is the dedicated agent itself and this branch is skipped.
  if (
    getBootConfig().preferSharedCloudTier &&
    selectedAgent.created &&
    isDirectCloudSharedAgentBase(cloudAgentApiBase)
  ) {
    const sharedAgentId = selectedAgent.agentId;
    const cloudApiBase =
      getBootConfig().cloudApiBase || "https://elizacloud.ai";
    const createDedicatedHandoffTarget = async (): Promise<string> => {
      const dedicated = await client.createCloudCompatAgent({
        agentName: name,
        ...(bio.length ? { agentConfig: { bio } } : {}),
        forceCreate: true,
      });
      if (dedicated.success && dedicated.data.agentId) {
        return dedicated.data.agentId;
      }
      throw new Error(
        dedicated.success
          ? "Dedicated agent creation returned no agent id."
          : (dedicated.data.message ?? "Dedicated agent creation failed."),
      );
    };
    runCloudAgentHandoff(
      sharedAgentId,
      async () => {
        const dedicatedAgentId = await createDedicatedHandoffTarget();
        // Reload insurance: the supervisor is in-memory, so persist the exact
        // migration target. A reload mid-boot resumes THIS handoff at startup
        // (resumePendingCloudHandoff) instead of stranding the user on the
        // shared adapter; silentlyRepointToDedicated clears the marker.
        savePendingCloudHandoff({
          sharedAgentId,
          dedicatedAgentId,
          sharedApiBase: cloudAgentApiBase,
          cloudApiBase,
          startedAt: Date.now(),
        });
        return await client.startCloudAgentHandoff({
          agentId: sharedAgentId,
          sharedApiBase: cloudAgentApiBase,
          conversationId: sharedAgentId,
          dedicatedAgentId,
          cloudApiBase,
          authToken,
          onSwitch: (containerBase) => {
            silentlyRepointToDedicated({
              containerBase,
              authToken,
              dedicatedAgentId,
            });
          },
        });
      },
      () => {
        removeAgentProfile(sharedAgentProfile.id);
        void client
          .deleteSharedBridgeAgent(sharedAgentId, {
            cloudApiBase,
            authToken,
          })
          .then((res) => {
            if (!res.success) {
              console.warn(
                `[firstRunFinish] shared bridge delete failed (leaked row ${sharedAgentId}): ${res.error ?? "unknown"}`,
              );
            }
          });
      },
    );
  }
  return { kind: "done" };
}

/**
 * Cloud finish entry: connect Eliza Cloud (Steward), then list the user's cloud
 * agents. 0 agents → auto-provision; ≥1 → return `pick-cloud-agent` so the
 * conductor seeds a `[CHOICE:first-run id=cloud-agent]` block.
 */
export async function listOrAutoProvisionCloudAgent(
  sourceDraft: FirstRunProfileDraft,
  ports: FirstRunFinishPorts,
): Promise<FirstRunFinishOutcome> {
  syncIdentity(sourceDraft, ports);
  ports.setRuntimeState(
    "firstRunRuntimeTarget",
    firstRunRuntimeTarget("cloud"),
  );
  ports.setRuntimeState("firstRunProvider", "elizacloud");
  let cloudConnectedForFinish = ports.elizaCloudConnected;
  if (!cloudConnectedForFinish) {
    const cloudStatus = await getCloudStatusIfSupported();
    cloudConnectedForFinish = isCloudStatusAuthenticated(
      Boolean(cloudStatus?.connected),
      cloudStatus?.reason,
    );
  }
  if (firstRunNeedsCloudConnect(sourceDraft, cloudConnectedForFinish)) {
    const authWindow = ports.preOpenWindow?.() ?? null;
    await ports.handleCloudLogin(authWindow);
    const cloudStatus = await getCloudStatusIfSupported();
    cloudConnectedForFinish = isCloudStatusAuthenticated(
      Boolean(cloudStatus?.connected),
      cloudStatus?.reason,
    );
    if (!cloudConnectedForFinish && getCloudAuthToken(client)) {
      cloudConnectedForFinish = true;
    }
    if (!cloudConnectedForFinish) {
      return { kind: "needs-cloud-login" };
    }
  }
  const authToken = getCloudAuthToken(client) ?? "";
  if (!authToken) {
    return { kind: "error", message: "Eliza Cloud authentication required." };
  }
  let list: { success: boolean; data: CloudCompatAgent[]; error?: string };
  try {
    list = await client.getCloudCompatAgents();
  } catch {
    // A thrown error here is a TRANSPORT failure (offline / DNS / timeout),
    // not an API message — the client returns { success:false } for real API
    // errors. Surface a friendly, actionable line instead of leaking the raw
    // `Unable to resolve host "api.elizacloud.ai"` UnknownHostException to the
    // onboarding chat.
    list = {
      success: false,
      data: [],
      error:
        "Couldn't reach Eliza Cloud — check your internet connection and try again.",
    };
  }
  if (!list.success) {
    return {
      kind: "error",
      message: list.error ?? "Could not load your agents. Try again.",
    };
  }
  if (list.data.length === 0) {
    return bindCloudAgent(
      sourceDraft,
      authToken,
      { forceCreate: false },
      ports,
    );
  }
  return {
    kind: "pick-cloud-agent",
    agents: sortCloudAgentsForPicker(list.data),
  };
}

// ── Router entry — validate + route by runtime ───────────────────────────────

/**
 * Draft narrowed to the runtimes this finish path actually provisions. The
 * live remote flow is `adopt-remote-first-run.ts` (via
 * `handleFirstRunRemoteConnect`) and never routes through here.
 */
export type FirstRunFinishDraft = FirstRunProfileDraft & {
  runtime: Exclude<FirstRunRuntime, "remote">;
};

export async function runFirstRunFinish(
  sourceDraft: FirstRunFinishDraft,
  ports: FirstRunFinishPorts,
): Promise<FirstRunFinishOutcome> {
  const validation = validateFirstRunSubmitDraft(sourceDraft);
  if (!validation.valid) {
    return {
      kind: "error",
      message:
        validation.message ?? "Check your first-run details and try again.",
    };
  }
  try {
    if (sourceDraft.runtime === "cloud") {
      return await listOrAutoProvisionCloudAgent(sourceDraft, ports);
    }
    return await finishLocal(sourceDraft, ports);
  } catch (err) {
    ports.onStatus?.(null);
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "First-run setup failed.",
    };
  }
}

/** Re-read the active cloud agent id (for the picker's "already bound" guard). */
export function readActiveCloudAgentId(): string | null {
  const active = loadPersistedActiveServer();
  if (active?.kind !== "cloud") return null;
  const id = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : "";
  return id && !id.includes("/") ? id : null;
}
