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
import type { DedicatedAdoptionConfirmationRequester } from "../api/client-cloud";
import { getCloudAuthToken } from "../api/client-cloud";
import type { CloudCompatAgent } from "../api/client-types-cloud";
import { getDesktopRuntimeMode, invokeDesktopBridgeRequest } from "../bridge";
import { type AgentPluginLike, getAgentPlugin } from "../bridge/native-plugins";
import { setStorageValue } from "../bridge/storage-bridge";
import {
  clearPendingCloudHandoff,
  loadPendingCloudHandoff,
} from "../cloud/handoff/pending-handoff-store";
import { silentlyRepointToDedicated } from "../cloud/handoff/silent-repoint";
import { runJoinFlow } from "../cloud/join/lib/run-join-flow";
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
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../state";
import { addAgentProfileDurably } from "../state/agent-profiles";
import { runAgentSessionRecovery } from "../state/agent-session-recovery-runner";
import { isPersistedActiveServerAllowed } from "../state/persistence";
import type { CloudLoginOptions } from "../state/types";
import { isCloudStatusAuthenticated } from "../utils";
import { autoDownloadRecommendedLocalModelInBackground } from "./auto-download-recommended";
import { createCloudContinuationAuthority } from "./cloud-continuation-authority";
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
import { revertLocalRuntimeCommitmentBeforeCloud } from "./revert-local-runtime-commitment";
import { resolveFirstRunLocalAgentApiBase } from "./runtime-target";

const FIRST_RUN_AGENT_WAIT_MS = 180_000;

// ── Injected ports — the store seams the finish logic needs ──────────────────

export interface FirstRunFinishPorts {
  uiLanguage: UiLanguage;
  elizaCloudConnected: boolean;
  /**
   * False for boot-time session recovery, where no user gesture authorized
   * opening an authentication surface. A missing or rejected credential must
   * return `needs-cloud-login` so the conductor can render its sign-in choice.
   */
  allowInteractiveCloudLogin?: boolean;
  /** Only the explicit Local → Cloud chooser may unwind a local runtime commitment. */
  revertLocalRuntimeBeforeCloud?: boolean;
  /**
   * Interactive Cloud login entry point: pre-opens the named popup window
   * itself, so the first-run flow cannot omit it (#17129). Use this for
   * user-facing login; the deliberate same-tab boot-recovery path lives on
   * the separately-named recovery entry point (use-boot-recovery-conductor).
   */
  handleInteractiveCloudLogin: (options?: CloudLoginOptions) => Promise<void>;
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
  /**
   * Cooperative cancellation for an abandoned attempt (#19255): checked
   * before every mutation and after every await boundary on the cloud path,
   * so a deadline-abandoned attempt cannot provision, persist, or complete
   * first-run concurrently with a newer attempt. Aborting settles the flow
   * with an AbortError rejection the caller treats as an expected stale
   * outcome, preserving the one-finish/provision-at-a-time invariant.
   */
  signal?: AbortSignal;
  /**
   * Fires when the flow reaches interactive Cloud login (#19255): lets the
   * conductor seed the waiting turn and arm the bounded recovery deadline
   * for entries that started silent (stored Steward token) and only later
   * degraded into OAuth.
   */
  onInteractiveLogin?: () => void;
  /**
   * Fires immediately after interactive Cloud login settles successfully so
   * the conductor can retire the OAuth-only recovery deadline before personal
   * agent activation begins.
   */
  onInteractiveLoginComplete?: () => void;
  /** Visible first-run quote/consent seam; absent callers stay read-only. */
  requestDedicatedAdoptionConfirmation?: DedicatedAdoptionConfirmationRequester;
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
  // RAM-tier gate (#14390), enforced BEFORE any side effect: hybrid mode uses
  // the 4 GB runtime-only floor, an unconfigured/full local runtime uses 8 GB,
  // and on-device models use 12 GB. The onboarding UI already blocks these
  // picks, but this is the fail-loud backstop for every caller — the throw
  // surfaces as the onboarding error turn with the runtime-recovery choice.
  await assertDeviceRamTierAllowsLocalRuntime(sourceDraft.localInference);
  syncIdentity(sourceDraft, ports);
  // Local + cloud-inference (hybrid) routes inference through Eliza Cloud, so
  // connect the cloud account first.
  if (firstRunNeedsCloudConnect(sourceDraft, ports.elizaCloudConnected)) {
    ports.setRuntimeState("firstRunRuntimeTarget", "elizacloud-hybrid");
    ports.setRuntimeState("firstRunProvider", "elizacloud");
    await ports.handleInteractiveCloudLogin();
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
 * Bind the personal identity or the exact existing agent selected by the picker.
 * Completing onboarding never authorizes runtime creation, wake, or migration.
 */
export async function bindCloudAgent(
  sourceDraft: FirstRunProfileDraft,
  authToken: string,
  opts: {
    preferAgentId?: string | null;
    forceCreate?: boolean;
    knownAgents?: CloudCompatAgent[];
  },
  ports: FirstRunFinishPorts,
): Promise<FirstRunFinishOutcome> {
  ports.signal?.throwIfAborted();
  ports.onStatus?.("Opening your cloud agent", "setup");
  const plan = buildFirstRunSubmitPlan({
    draft: { ...sourceDraft, runtime: "cloud" },
    uiLanguage: ports.uiLanguage,
  });
  const cloudApiBase = getBootConfig().cloudApiBase || "https://eliza.app";
  const selectedAgent = await client.resolveCloudAgentForEntry({
    cloudApiBase,
    authToken,
    ...(opts.preferAgentId ? { preferAgentId: opts.preferAgentId } : {}),
    ...(opts.forceCreate ? { forceCreate: true } : {}),
    ...(ports.signal ? { signal: ports.signal } : {}),
  });
  // The remote agent now exists/was selected; every step after this point
  // mutates local durable state, so an abandoned attempt stops HERE (#19255).
  ports.signal?.throwIfAborted();
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
      ports.signal?.throwIfAborted();
      if (pairMode === "in-process") {
        persistMobileRuntimeModeForServerTarget("elizacloud");
        clearForceFreshFirstRun();
        clearPersistedFirstRunState();
        // Durable completion is persisted HERE, at the landing itself, for the
        // same reason as the main bind path below (#15903).
        savePersistedFirstRunComplete(true);
        ports.onStatus?.(null);
        ports.completeFirstRun("chat");
        return { kind: "done" };
      }
      // `navigate` hands the window to the agent's /pair relay — this JS
      // session ends now, so the conductor's completion callback never runs.
      // Persist the durable flag before the unload or the returning boot
      // re-enters first-run despite a successful landing (#15903).
      savePersistedFirstRunComplete(true);
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
  // Do not pre-warm a runtime during entry: its proxy may wake paid compute.
  // The authenticated chat surface owns its actual conversation reads.
  ports.signal?.throwIfAborted();
  const activeServer = createPersistedActiveServer({
    kind: "cloud",
    id: `cloud:${selectedAgent.agentId}`,
    apiBase: cloudAgentApiBase,
    accessToken: authToken,
    cloudRuntime: selectedAgent.runtime,
    cloudRuntimeAgentId: selectedAgent.activeAgentId,
  });
  savePersistedActiveServer(activeServer);
  addAgentProfile({
    kind: "cloud",
    label: activeServer.label,
    cloudAgentId: selectedAgent.agentId,
    cloudRuntime: selectedAgent.runtime,
    cloudRuntimeAgentId: selectedAgent.activeAgentId,
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
  // Persist the durable completion contract at the landing ITSELF, not only
  // through the conductor's completion callback: every successful cloud
  // landing — fresh provision AND the returning-account "Finding your
  // agents…" reuse — must leave `eliza:first-run-complete` set, or the next
  // launch re-enters first-run for a user whose agent is healthy (#15903).
  // Idempotent with the callback's own setFirstRunComplete(true) persist.
  ports.signal?.throwIfAborted();
  savePersistedFirstRunComplete(true);
  ports.onStatus?.(null);
  ports.completeFirstRun("chat");

  // Marker hygiene (#15902): a pending-handoff marker is only meaningful for
  // the shared agent it was minted for. A leftover marker from a different
  // (earlier, failed) onboarding must not suppress this landing's upgrade path
  // or pin the provisioning tile in "Setting up…" — clear it; this landing's
  // own state drives from here.
  const pendingHandoff = loadPendingCloudHandoff();
  const pendingHandoffForThisAgent =
    pendingHandoff && pendingHandoff.sharedAgentId === selectedAgent.agentId
      ? pendingHandoff
      : null;
  if (pendingHandoff && !pendingHandoffForThisAgent) {
    clearPendingCloudHandoff();
  }

  // Host flags and reload markers carry no current quote-bound consent.
  // Preserve a matching marker for explicit recovery, but never start or
  // resume a paid migration as a side effect of completing onboarding.
  return { kind: "done" };
}

/**
 * Cloud finish entry: connect Eliza Cloud (Steward), then bind the account's
 * current personal runtime without provisioning. Runtime lifecycle management
 * belongs in Settings after onboarding, behind explicit consent.
 */
export async function listOrAutoProvisionCloudAgent(
  sourceDraft: FirstRunProfileDraft,
  ports: FirstRunFinishPorts,
): Promise<FirstRunFinishOutcome> {
  ports.signal?.throwIfAborted();
  let capturedAuthority = getCloudAuthToken(client)
    ? await createCloudContinuationAuthority(client, ports.signal)
    : null;
  try {
    if (ports.revertLocalRuntimeBeforeCloud) {
      const preparation =
        capturedAuthority ??
        (await createCloudContinuationAuthority(client, ports.signal));
      try {
        await revertLocalRuntimeCommitmentBeforeCloud({
          ...preparation.storageOptions,
          acceptClearedServer: () => preparation.acceptServer(null),
        });
        preparation.revalidate();
      } finally {
        if (preparation !== capturedAuthority) preparation.dispose();
      }
    }
    syncIdentity(sourceDraft, ports);
    capturedAuthority?.revalidate();
    ports.setRuntimeState(
      "firstRunRuntimeTarget",
      firstRunRuntimeTarget("cloud"),
    );
    ports.setRuntimeState("firstRunProvider", "elizacloud");
    capturedAuthority?.revalidate();
    if (!getCloudAuthToken(client)) {
      if (ports.allowInteractiveCloudLogin === false) {
        return { kind: "needs-cloud-login" };
      }
      // Interactive OAuth is the unbounded wait (#19255): tell the conductor so
      // it can seed the waiting turn and arm the bounded recovery deadline.
      ports.onInteractiveLogin?.();
      await ports.handleInteractiveCloudLogin({ requireClientAuth: true });
      ports.onInteractiveLoginComplete?.();
      ports.signal?.throwIfAborted();
    }
    const authToken = getCloudAuthToken(client) ?? "";
    if (!authToken) {
      return { kind: "needs-cloud-login" };
    }
    // The join flow persists durable local state; a deadline-abandoned attempt
    // stops HERE (#19255) so it cannot race a newer attempt's join.
    ports.signal?.throwIfAborted();
    const cloudApiBase = getBootConfig().cloudApiBase || "https://eliza.app";
    const authority =
      capturedAuthority ??
      (await createCloudContinuationAuthority(client, ports.signal));
    capturedAuthority = authority;
    authority.revalidate();
    await authority.prepareProfiles();
    await authority.assertNative();
    let firstRunReady = false;
    const selected = await runJoinFlow({
      client: {
        getPersonalSharedEliza: (options) =>
          client.getPersonalSharedEliza(options),
        setBaseUrl: (base) =>
          authority.commitClient(() => client.setBaseUrl(base), { base }),
        setToken: (token) =>
          authority.commitClient(() => client.setToken(token), { token }),
      },
      effects: {
        savePersistedActiveServer: async (server) => {
          authority.revalidate();
          const target = createPersistedActiveServer(server);
          if (!isPersistedActiveServerAllowed(target))
            throw new Error(
              "First-run target is outside the build-pinned runtime",
            );
          await setStorageValue(
            "elizaos:active-server",
            JSON.stringify(target),
            authority.storageOptions,
          );
          authority.acceptServer(target);
        },
        // The outer finish owns profile durability and the final completion
        // gate; join readiness alone must not make a partial native write final.
        savePersistedFirstRunComplete: (complete) => {
          firstRunReady = complete;
        },
      },
      cloudApiBase,
      authToken,
      signal: authority.signal,
      revalidate: authority.revalidate,
      onProgress: (status, detail) => {
        authority.revalidate();
        ports.onStatus?.(detail ?? status, status);
        authority.revalidate();
      },
      ...(ports.requestDedicatedAdoptionConfirmation
        ? {
            requestDedicatedAdoptionConfirmation:
              ports.requestDedicatedAdoptionConfirmation,
          }
        : {}),
    });
    authority.revalidate();
    const profile = await addAgentProfileDurably(
      {
        kind: "cloud",
        label: selected.agentName,
        cloudAgentId: selected.agentId,
        cloudRuntimeAgentId: selected.activeAgentId,
        cloudRuntime: selected.runtime,
        apiBase: selected.apiBase,
        accessToken: authToken,
      },
      authority.revalidate,
      authority.storageOptions.nativeAuthority,
      authority.signal,
    );
    authority.acceptProfile(profile);
    await authority.assertNative();
    persistMobileRuntimeModeForServerTarget("elizacloud");
    clearForceFreshFirstRun();
    clearPersistedFirstRunState();
    ports.onStatus?.(null);
    authority.revalidate();
    if (!firstRunReady) throw new Error("First-run join did not complete");
    savePersistedFirstRunComplete(true);
    authority.revalidate();
    ports.completeFirstRun("chat");
    return { kind: "done" };
  } finally {
    capturedAuthority?.dispose();
  }
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
