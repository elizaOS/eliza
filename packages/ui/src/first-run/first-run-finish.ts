/**
 * Headless first-run "finish" use case.
 *
 * This is the SINGLE provisioning implementation for completing onboarding. It
 * owns no presentation — the in-chat first-run conductor
 * (`use-first-run-conductor.ts`) calls these functions and renders the seeded
 * chat messages. All product decisions (default provider, needsProviderSetup,
 * the POST body) live in the pure config layer (`first-run-config.ts` /
 * `first-run.ts`); this module wires the ports.
 *
 * Every `POST /api/first-run` funnels through the single, idempotency-guarded
 * `persistFirstRun` helper, so a completed onboarding posts exactly once.
 */

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
import { clearForceFreshFirstRun } from "../platform/first-run-reset";
import {
  isAndroid,
  isDesktopPlatform,
  isIOS,
  isNative,
} from "../platform/init";
import {
  addAgentProfile,
  createPersistedActiveServer,
  loadPersistedActiveServer,
  removeAgentProfile,
  savePersistedActiveServer,
} from "../state";
import { runAgentSessionRecovery } from "../state/agent-session-recovery-runner";
import { isCloudStatusAuthenticated } from "../utils";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";
import { assertDeviceRamTierAllowsLocalRuntime } from "./device-ram-gate";
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
const RUNNING_CLOUD_AGENT_STATUS = "running";

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
  setTab: (tab: string) => void;
  /** Injected client-side finalizer (flips firstRunComplete; never POSTs). */
  completeFirstRun: (landingTab?: string) => void;
  /**
   * Status text (e.g. "Starting local agent") surfaced into the chat
   * transcript. `code` is the machine-readable phase behind the text: this
   * module's own "setup" / "persist" phases plus the cloud client's
   * `onProgress` status vocabulary ("listing" / "creating" / "provisioning" /
   * "starting" / "ready") forwarded verbatim. The conductor's silent cloud
   * entry (#15133) keys off it to tell a REAL provisioning wait apart from
   * reuse narration; text-only consumers ignore it.
   */
  onStatus?: (text: string | null, code?: string) => void;
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
  | { kind: "handoff-started" }
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
  _ports: FirstRunFinishPorts,
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
      // needsProviderSetup no longer raises a floating banner: the transcript's
      // no-provider gate and the composer's Settings placeholder hint are the
      // honest in-chat surfaces for an unconfigured provider.
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
    // error-policy:J3 unparseable base — fail closed as "not loopback"
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
    // error-policy:J3 unparseable base — fail closed as "no proxy"
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

function runningCloudAgents(
  agents: readonly CloudCompatAgent[],
): CloudCompatAgent[] {
  return agents
    .filter((agent) => agent.status === RUNNING_CLOUD_AGENT_STATUS)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function getCloudStatusIfSupported() {
  if (!canProbeCloudStatus()) return null;
  // error-policy:J4 cloud-status probe — unreachable/unsupported means the
  // finish flow skips the cloud handoff, which is the designed degrade
  return client.getCloudStatus().catch(() => null);
}

async function pairDedicatedCloudAgentInCurrentWindow(opts: {
  cloudApiBase: string;
  agentId: string;
  cloudToken: string;
  containerBase?: string;
}): Promise<"navigate" | "in-process"> {
  if (typeof window === "undefined") {
    throw new Error("Cloud agent sign-in requires a browser window.");
  }
  const result = await runAgentSessionRecovery({
    cloudApiBase: opts.cloudApiBase,
    agentId: opts.agentId,
    cloudToken: opts.cloudToken,
    consumeRedirectInProcess: isNative && !isDesktopPlatform(),
    onPairedInProcess: (apiToken) => {
      if (opts.containerBase) {
        silentlyRepointToDedicated({
          containerBase: opts.containerBase,
          dedicatedAgentId: opts.agentId,
          authToken: apiToken,
        });
      } else {
        client.setToken(apiToken);
      }
    },
    navigate: (url) => {
      window.location.replace(url);
    },
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.mode;
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
    // error-policy:J4 native-bridge probe — no token means the request path
    // proceeds tokenless and the local agent's 401 surfaces there
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
    // error-policy:J4 the agent plugin is not registered on this host —
    // load it directly; a failure of this direct start still propagates
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
      // error-policy:J4 mode probe — unknown mode proceeds with the local
      // start below, whose failure is handled explicitly
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
      // error-policy:J4 the bridge start can fail when the agent is already
      // running — probe the API; only rethrow when it is truly unreachable
      try {
        await client.getAuthStatus();
        return;
      } catch {
        // error-policy:J2 agent unreachable — surface the original failure
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
      // error-policy:J4 boot poll — retry with backoff; the loop throws a
      // deadline error below when the agent never comes up
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(Math.round(delayMs * 1.35), 4_000);
    }
  }
  throw new Error(
    "The agent API did not become ready before the first-run deadline.",
  );
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
  // RAM-tier gate (#14390), enforced BEFORE any side effect: a device below
  // the 8 GB floor may not run the on-device agent at all, and one below the
  // 12 GB floor may not download/run on-device models. The onboarding UI
  // already blocks these picks, but this is the fail-loud backstop for every
  // caller — the throw surfaces as the onboarding error turn with the
  // runtime-recovery choice.
  await assertDeviceRamTierAllowsLocalRuntime(sourceDraft.localInference);
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
  ports.onStatus?.("Starting local agent", "setup");
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
  ports.onStatus?.("Saving first-run profile", "persist");
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
  ports.onStatus?.("Setting up your cloud agent", "setup");
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
  const cloudApiBase = getBootConfig().cloudApiBase || "https://elizacloud.ai";
  const selectedAgent = await client.selectOrProvisionCloudAgent({
    cloudApiBase,
    authToken,
    name,
    bio,
    ...(opts.preferAgentId ? { preferAgentId: opts.preferAgentId } : {}),
    ...(opts.forceCreate ? { forceCreate: true } : {}),
    ...(getBootConfig().preferSharedCloudTier
      ? { preferSharedTier: true }
      : {}),
    onProgress: (status, detail) => ports.onStatus?.(detail ?? status, status),
  });
  const cloudAgentApiBase = selectedAgent.apiBase;
  if (selectedAgent.requiresAgentPairing) {
    ports.onStatus?.("Signing in to your cloud agent", "pairing");
    try {
      const pairMode = await pairDedicatedCloudAgentInCurrentWindow({
        cloudApiBase,
        agentId: selectedAgent.agentId,
        cloudToken: authToken,
        containerBase: cloudAgentApiBase,
      });
      if (pairMode === "in-process") {
        persistMobileRuntimeModeForServerTarget("elizacloud");
        clearForceFreshFirstRun();
        clearPersistedFirstRunState();
        ports.onStatus?.(null);
        ports.completeFirstRun("chat");
        return { kind: "done" };
      }
      return { kind: "handoff-started" };
    } catch (err) {
      return {
        kind: "error",
        message: `Couldn't sign in to your cloud agent: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
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
  ports.onStatus?.("Saving first-run profile", "persist");
  // Direct Cloud agent bases are chat runtimes, not full app-shell setup
  // servers — they do not own /api/first-run. Only persist when the bound base
  // owns the app-shell routes.
  if (supportsFullAppShellRoutes(cloudAgentApiBase)) {
    await persistFirstRun(plan, ports);
  }
  // A shared/dedicated cloud agent SKIPS persistFirstRun above, so it never
  // reaches the `client.submitFirstRun` call that clears the durable
  // force-fresh flag via the reset client patch. Without clearing it here, a
  // user who onboarded through the escape hatch (`?reset` / a prior in-session
  // agent reset that armed force-fresh) completes a shared-agent onboarding but
  // leaves `elizaos:first-run:force-fresh` armed — so the NEXT cold boot /
  // PWA relaunch re-runs the restore-phase force-fresh consume
  // (savePersistedFirstRunComplete(false) + clear active server) and bounces
  // the returning user back into "Setting up your agent…" even though their
  // agent is healthy and running. Clear it on the cloud completion path too so
  // "completion clears force-fresh" holds for EVERY runtime (idempotent — the
  // app-shell path's submitFirstRun already cleared it above).
  clearForceFreshFirstRun();
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
      if (!dedicated.success || !dedicated.data.agentId) {
        throw new Error(
          dedicated.success
            ? "Dedicated agent creation returned no agent id."
            : (dedicated.data.message ?? "Dedicated agent creation failed."),
        );
      }
      const dedicatedAgentId = dedicated.data.agentId;
      // Reload insurance, persisted the INSTANT the dedicated target id is known
      // — before the 30-120s container boot in startCloudAgentHandoff, with no
      // await between learning the id and persisting it. The supervisor is
      // in-memory, so a kill mid-boot resumes THIS exact handoff at startup
      // (resumePendingCloudHandoff) instead of stranding the user on the shared
      // adapter off the auto-upgrade path; silentlyRepointToDedicated clears the
      // marker once the swap lands.
      savePendingCloudHandoff({
        sharedAgentId,
        dedicatedAgentId,
        sharedApiBase: cloudAgentApiBase,
        cloudApiBase,
        startedAt: Date.now(),
      });
      return dedicatedAgentId;
    };
    runCloudAgentHandoff(
      sharedAgentId,
      async () => {
        const dedicatedAgentId = await createDedicatedHandoffTarget();
        return await client.startCloudAgentHandoff({
          agentId: sharedAgentId,
          sharedApiBase: cloudAgentApiBase,
          conversationId: sharedAgentId,
          dedicatedAgentId,
          cloudApiBase,
          authToken,
          onSwitch: async (containerBase) => {
            await pairDedicatedCloudAgentInCurrentWindow({
              cloudApiBase,
              agentId: dedicatedAgentId,
              cloudToken: authToken,
              containerBase,
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
 * Cloud finish entry: connect Eliza Cloud (Steward), then bind the best healthy
 * existing agent or create one if needed. First-run stays a single clean path;
 * specific agent management belongs in Settings after onboarding.
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
  ports.onStatus?.("Finding your agents...", "listing");
  const list = await client.getCloudCompatAgents();
  if (!list.success) {
    return {
      kind: "error",
      message:
        list.error ||
        "Couldn't reach Eliza Cloud to find your agents. Check your connection and try again.",
    };
  }
  const running = runningCloudAgents(list.data);
  if (running.length > 1) {
    ports.onStatus?.(null);
    return { kind: "pick-cloud-agent", agents: running };
  }
  return bindCloudAgent(
    sourceDraft,
    authToken,
    {
      forceCreate: false,
      ...(running[0]?.agent_id ? { preferAgentId: running[0].agent_id } : {}),
    },
    ports,
  );
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
    // error-policy:J1 finish boundary — translate the failure into the
    // structured error outcome the onboarding chat renders
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
