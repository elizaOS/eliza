/**
 * Chat lifecycle callbacks — agent start/stop/restart/reset operations.
 *
 * Extracted from useChatCallbacks.ts. Handles all agent lifecycle transitions,
 * desktop notifications, and full-reset flows.
 */

import { getDefaultStylePreset } from "@elizaos/shared";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type {
  Conversation,
  ConversationMessage,
  OnboardingOptions,
} from "../api";
import { type AgentStatus, client, type StreamEventEnvelope } from "../api";
import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../bridge";
import { dispatchElizaCloudStatusUpdated } from "../events";
import { persistMobileRuntimeModeForServerTarget } from "../onboarding/mobile-runtime-mode";
import { enableForceFreshOnboarding } from "../platform";
import { alertDesktopMessage, confirmDesktopAction } from "../utils";
import { completeResetLocalStateAfterServerWipe as runCompleteResetLocalStateAfterServerWipe } from "./complete-reset-local-state-after-wipe";
import { handleResetAppliedFromMainCore } from "./handle-reset-applied-from-main";
import type { AppState, LifecycleAction } from "./internal";
import {
  clearAvatarIndex,
  clearPersistedActiveServer,
  LIFECYCLE_MESSAGES,
  parseAgentStatusFromMainMenuResetPayload,
} from "./internal";
import type { OnboardingMode, OnboardingStep } from "./types";

// ── Helpers (file-local) ────────────────────────────────────────────

const RESET_LOG_PREFIX = "[eliza][reset]";

function logResetDebug(
  message: string,
  detail?: Record<string, unknown>,
): void {
  if (detail !== undefined && Object.keys(detail).length > 0) {
    console.debug(`${RESET_LOG_PREFIX} ${message}`, detail);
  } else {
    console.debug(`${RESET_LOG_PREFIX} ${message}`);
  }
}

function logResetInfo(message: string, detail?: Record<string, unknown>): void {
  if (detail !== undefined && Object.keys(detail).length > 0) {
    console.info(`${RESET_LOG_PREFIX} ${message}`, detail);
  } else {
    console.info(`${RESET_LOG_PREFIX} ${message}`);
  }
}

function logResetWarn(message: string, detail?: unknown): void {
  console.warn(`${RESET_LOG_PREFIX} ${message}`, detail);
}

async function waitForLifecycleIdle(
  lifecycleBusyRef: MutableRefObject<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = performance.now();
  while (lifecycleBusyRef.current) {
    if (performance.now() - startedAt >= timeoutMs) {
      return false;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 100);
    });
  }
  return true;
}

/** Publish server cloud snapshot for chat TTS (`useVoiceChat` + `loadVoiceConfig`). */
function publishElizaCloudVoiceSnapshot(
  setCloudVoiceProxyAvailable: (value: boolean) => void,
  setHasPersistedKey: (value: boolean) => void,
  snapshot: {
    apiConnected: boolean;
    enabled: boolean;
    cloudVoiceProxyAvailable: boolean;
    hasPersistedApiKey: boolean;
  },
): void {
  setCloudVoiceProxyAvailable(snapshot.cloudVoiceProxyAvailable);
  setHasPersistedKey(snapshot.hasPersistedApiKey);
  dispatchElizaCloudStatusUpdated({
    connected: snapshot.apiConnected,
    enabled: snapshot.enabled,
    hasPersistedApiKey: snapshot.hasPersistedApiKey,
    cloudVoiceProxyAvailable: snapshot.cloudVoiceProxyAvailable,
  });
}

// ── Deps interface ──────────────────────────────────────────────────

export interface UseChatLifecycleDeps {
  // Agent status
  agentStatus: AgentStatus | null;
  setAgentStatus: (s: AgentStatus | null) => void;

  // Lifecycle
  lifecycleAction: LifecycleAction | null;
  beginLifecycleAction: (action: LifecycleAction) => boolean;
  finishLifecycleAction: () => void;
  lifecycleBusyRef: MutableRefObject<boolean>;
  lifecycleActionRef: MutableRefObject<LifecycleAction | null>;
  setActionNotice: (
    text: string,
    tone: "success" | "error" | "info",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;

  // Pending restart
  pendingRestart: boolean;
  pendingRestartReasons: string[];
  setPendingRestart: (v: boolean) => void;
  setPendingRestartReasons: (
    v: string[] | ((prev: string[]) => string[]),
  ) => void;

  // Backend connection
  setBackendDisconnectedBannerDismissed: (v: boolean) => void;
  resetBackendConnection: () => void;

  // Loaders
  loadConversations: () => Promise<Conversation[] | null>;
  loadPlugins: () => Promise<unknown>;

  // Greeting / hydration (injected from parent to avoid circular deps)
  hydrateInitialConversationState: () => Promise<string | null>;
  requestGreetingWhenRunning: (convId: string | null) => Promise<void>;

  // Reset conversation state
  interruptActiveChatPipeline: () => void;
  resetConversationDraftState: () => void;
  setActiveConversationId: (v: string | null) => void;
  setConversationMessages: (
    v:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
  setConversations: (
    v: Conversation[] | ((prev: Conversation[]) => Conversation[]),
  ) => void;
  activeConversationIdRef: MutableRefObject<string | null>;

  // Cloud state
  elizaCloudPreferDisconnectedUntilLoginRef: MutableRefObject<boolean>;
  setElizaCloudEnabled: (v: boolean) => void;
  setElizaCloudConnected: (v: boolean) => void;
  setElizaCloudVoiceProxyAvailable: (v: boolean) => void;
  setElizaCloudHasPersistedKey: (v: boolean) => void;
  setElizaCloudCredits: (v: number | null) => void;
  setElizaCloudCreditsLow: (v: boolean) => void;
  setElizaCloudCreditsCritical: (v: boolean) => void;
  setElizaCloudAuthRejected: (v: boolean) => void;
  setElizaCloudCreditsError: (v: string | null) => void;
  setElizaCloudTopUpUrl: (v: string) => void;
  setElizaCloudUserId: (v: string | null) => void;
  setElizaCloudStatusReason: (v: string | null) => void;
  setElizaCloudLoginError: (v: string | null) => void;

  // Onboarding setters
  onboardingCompletionCommittedRef: MutableRefObject<boolean>;
  setOnboardingUiRevealNonce: (fn: (n: number) => number) => void;
  setOnboardingLoading: (v: boolean) => void;
  setOnboardingComplete: (v: boolean) => void;
  setOnboardingStep: (v: OnboardingStep) => void;
  setOnboardingMode: (v: OnboardingMode) => void;
  setOnboardingActiveGuide: (v: string | null) => void;
  setOnboardingDeferredTasks: (v: string[]) => void;
  setPostOnboardingChecklistDismissed: (v: boolean) => void;
  setOnboardingName: (v: string) => void;
  setOnboardingStyle: (v: string) => void;
  setOnboardingServerTarget: (v: AppState["onboardingServerTarget"]) => void;
  setOnboardingProvider: (v: string) => void;
  setOnboardingApiKey: (v: string) => void;
  setOnboardingVoiceProvider: (v: string) => void;
  setOnboardingVoiceApiKey: (v: string) => void;
  setOnboardingPrimaryModel: (v: string) => void;
  setOnboardingOpenRouterModel: (v: string) => void;
  setOnboardingRemoteConnected: (v: boolean) => void;
  setOnboardingRemoteApiBase: (v: string) => void;
  setOnboardingRemoteToken: (v: string) => void;
  setOnboardingSmallModel: (v: string) => void;
  setOnboardingLargeModel: (v: string) => void;
  setOnboardingOptions: (v: OnboardingOptions | null) => void;

  // Character / avatar
  setSelectedVrmIndex: (v: number) => void;
  setCustomVrmUrl: (v: string) => void;
  setCustomBackgroundUrl: (v: string) => void;

  // Plugins / skills / logs
  setPlugins: (v: never[]) => void;
  setSkills: (v: never[]) => void;
  setLogs: (v: never[]) => void;

  // Startup coordinator
  coordinatorResetRef: MutableRefObject<(() => void) | null>;
}

// ── Hook ────────────────────────────────────────────────────────────

export function useChatLifecycle(deps: UseChatLifecycleDeps) {
  const defaultOnboardingStyle = getDefaultStylePreset();
  const {
    agentStatus,
    setAgentStatus,
    lifecycleAction,
    beginLifecycleAction,
    finishLifecycleAction,
    lifecycleBusyRef,
    lifecycleActionRef,
    setActionNotice,
    pendingRestart,
    pendingRestartReasons,
    setPendingRestart,
    setPendingRestartReasons,
    setBackendDisconnectedBannerDismissed,
    resetBackendConnection,
    loadPlugins,
    hydrateInitialConversationState,
    requestGreetingWhenRunning,
    interruptActiveChatPipeline,
    resetConversationDraftState,
    setActiveConversationId,
    setConversationMessages,
    setConversations,
    activeConversationIdRef,
    elizaCloudPreferDisconnectedUntilLoginRef,
    setElizaCloudEnabled,
    setElizaCloudConnected,
    setElizaCloudVoiceProxyAvailable,
    setElizaCloudHasPersistedKey,
    setElizaCloudCredits,
    setElizaCloudCreditsLow,
    setElizaCloudCreditsCritical,
    setElizaCloudAuthRejected,
    setElizaCloudCreditsError,
    setElizaCloudTopUpUrl,
    setElizaCloudUserId,
    setElizaCloudStatusReason,
    setElizaCloudLoginError,
    onboardingCompletionCommittedRef,
    setOnboardingUiRevealNonce,
    setOnboardingLoading,
    setOnboardingComplete,
    setOnboardingStep,
    setOnboardingMode,
    setOnboardingActiveGuide,
    setOnboardingDeferredTasks,
    setPostOnboardingChecklistDismissed,
    setOnboardingName,
    setOnboardingStyle,
    setOnboardingServerTarget,
    setOnboardingProvider,
    setOnboardingApiKey,
    setOnboardingVoiceProvider,
    setOnboardingVoiceApiKey,
    setOnboardingPrimaryModel,
    setOnboardingOpenRouterModel,
    setOnboardingRemoteConnected,
    setOnboardingRemoteApiBase,
    setOnboardingRemoteToken,
    setOnboardingSmallModel,
    setOnboardingLargeModel,
    setOnboardingOptions,
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomBackgroundUrl,
    setPlugins,
    setSkills,
    setLogs,
    coordinatorResetRef,
  } = deps;

  const heartbeatNotificationKeyRef = useRef<string | null>(null);
  const restartNotificationSignatureRef = useRef<string | null>(null);

  const handleStartDraftConversation = useCallback(async () => {
    interruptActiveChatPipeline();
    resetConversationDraftState();
  }, [interruptActiveChatPipeline, resetConversationDraftState]);

  const handleStart = useCallback(async () => {
    if (!beginLifecycleAction("start")) return;
    setActionNotice(
      LIFECYCLE_MESSAGES.start.progress,
      "info",
      300_000,
      false,
      true,
    );
    try {
      const s = await client.startAgent();
      setAgentStatus(s);
      setActionNotice(LIFECYCLE_MESSAGES.start.success, "success", 2400);
    } catch (err) {
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.start.verb} agent: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
    } finally {
      finishLifecycleAction();
    }
  }, [
    beginLifecycleAction,
    finishLifecycleAction,
    setActionNotice,
    setAgentStatus,
  ]);

  const handleStop = useCallback(async () => {
    if (!beginLifecycleAction("stop")) return;
    setActionNotice(
      LIFECYCLE_MESSAGES.stop.progress,
      "info",
      120_000,
      false,
      true,
    );
    try {
      const s = await client.stopAgent();
      setAgentStatus(s);
      setActionNotice(LIFECYCLE_MESSAGES.stop.success, "success", 2400);
    } catch (err) {
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.stop.verb} agent: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
    } finally {
      finishLifecycleAction();
    }
  }, [
    beginLifecycleAction,
    finishLifecycleAction,
    setActionNotice,
    setAgentStatus,
  ]);

  const handleRestart = useCallback(async () => {
    if (!beginLifecycleAction("restart")) return;
    setActionNotice(
      LIFECYCLE_MESSAGES.restart.progress,
      "info",
      300_000,
      false,
      true,
    );
    try {
      setAgentStatus({
        ...(agentStatus ?? {
          agentName: "Eliza",
          model: undefined,
          uptime: undefined,
          startedAt: undefined,
        }),
        state: "restarting",
      });
      // Server restart clears in-memory conversations — reset client state
      setActiveConversationId(null);
      setConversationMessages([]);
      setConversations([]);
      const s = await client.restartAndWait(120_000);
      setAgentStatus(s);
      const greetConvId = await hydrateInitialConversationState();
      await requestGreetingWhenRunning(greetConvId);
      setPendingRestart(false);
      setPendingRestartReasons([]);
      void loadPlugins();
      setActionNotice(LIFECYCLE_MESSAGES.restart.success, "success", 2400);
    } catch (err) {
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.restart.verb} agent: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
      setTimeout(async () => {
        try {
          setAgentStatus(await client.getStatus());
        } catch {
          /* ignore */
        }
      }, 3000);
    } finally {
      finishLifecycleAction();
    }
  }, [
    agentStatus,
    beginLifecycleAction,
    finishLifecycleAction,
    setActionNotice,
    hydrateInitialConversationState,
    loadPlugins,
    requestGreetingWhenRunning,
    setActiveConversationId,
    setAgentStatus,
    setConversationMessages,
    setConversations,
    setPendingRestart,
    setPendingRestartReasons,
  ]);

  const triggerRestart = useCallback(async () => {
    await handleRestart();
  }, [handleRestart]);

  const retryBackendConnection = useCallback(() => {
    setBackendDisconnectedBannerDismissed(false);
    client.resetConnection();
  }, [setBackendDisconnectedBannerDismissed]);

  const restartBackend = useCallback(async () => {
    const restarted = await invokeDesktopBridgeRequest({
      rpcMethod: "agentRestart",
      ipcChannel: "agent:restart",
    });
    if (restarted === null) {
      await client.restart();
    }
    resetBackendConnection();
  }, [resetBackendConnection]);

  const relaunchDesktop = useCallback(async () => {
    const relaunched = await invokeDesktopBridgeRequest<void>({
      rpcMethod: "desktopRelaunch",
      ipcChannel: "desktop:relaunch",
    });
    if (relaunched === null) {
      await handleRestart();
    }
  }, [handleRestart]);

  const showDesktopNotification = useCallback(
    async (options: {
      title: string;
      body?: string;
      urgency?: "normal" | "critical" | "low";
      silent?: boolean;
    }) => {
      try {
        await invokeDesktopBridgeRequest<{ id: string }>({
          rpcMethod: "desktopShowNotification",
          ipcChannel: "desktop:showNotification",
          params: options,
        });
      } catch {
        /* ignore desktop notification failures */
      }
    },
    [],
  );

  const notifyHeartbeatEvent = useCallback(
    (event: StreamEventEnvelope) => {
      const payload = event.payload as Record<string, unknown>;
      const status =
        typeof payload.status === "string"
          ? payload.status.trim().toLowerCase()
          : "ok";
      const silent = payload.silent === true;
      const isFailure = status === "error" || status === "failed";
      const isSkipped = status === "skipped";
      if (!isFailure && !isSkipped && silent) {
        return;
      }

      const eventTs =
        typeof payload.ts === "number"
          ? payload.ts
          : typeof event.ts === "number"
            ? event.ts
            : Date.now();
      const target =
        [
          typeof payload.channel === "string" ? payload.channel.trim() : "",
          typeof payload.to === "string" ? payload.to.trim() : "",
        ]
          .filter(Boolean)
          .join(" · ") || "background trigger";
      const notificationKey = `${eventTs}:${status}:${target}`;

      if (heartbeatNotificationKeyRef.current === notificationKey) {
        return;
      }
      heartbeatNotificationKeyRef.current = notificationKey;

      const preview =
        typeof payload.preview === "string" ? payload.preview.trim() : "";
      const reason =
        typeof payload.reason === "string" ? payload.reason.trim() : "";
      const duration =
        typeof payload.durationMs === "number"
          ? `Duration: ${Math.round(payload.durationMs)}ms`
          : "";

      const body = [target, preview, reason !== preview ? reason : "", duration]
        .filter(Boolean)
        .join("\n");

      void showDesktopNotification({
        title: isFailure
          ? "Heartbeat failed"
          : isSkipped
            ? "Heartbeat skipped"
            : "Heartbeat ran",
        body,
        urgency: isFailure ? "critical" : isSkipped ? "normal" : "low",
        silent: false,
      });
    },
    [showDesktopNotification],
  );

  const notifyAssistantEvent = useCallback(
    (event: StreamEventEnvelope) => {
      if (event.type !== "agent_event" || event.stream !== "assistant") {
        return;
      }
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      if (!payload) {
        return;
      }

      const source =
        typeof payload.source === "string" ? payload.source.trim() : "";
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text || source !== "lifeops-reminder") {
        return;
      }

      void showDesktopNotification({
        title: "Reminder",
        body: text,
        urgency: "normal",
        silent: false,
      });
    },
    [showDesktopNotification],
  );

  useEffect(() => {
    if (!pendingRestart) {
      restartNotificationSignatureRef.current = null;
      return;
    }

    const signature =
      pendingRestartReasons.length > 0
        ? pendingRestartReasons.join("\n")
        : "restart-required";
    if (restartNotificationSignatureRef.current === signature) {
      return;
    }
    restartNotificationSignatureRef.current = signature;

    const summary =
      pendingRestartReasons.length === 1
        ? pendingRestartReasons[0]
        : pendingRestartReasons.length > 1
          ? `${pendingRestartReasons.length} changes are waiting for restart.`
          : "Restart required to apply changes.";

    void showDesktopNotification({
      title: "Restart required",
      body: `${summary}\nUse Restart Now from the banner or Menu > Restart Agent. Use Menu > Relaunch App when the desktop shell itself needs a full relaunch.`,
      urgency: "normal",
      silent: false,
    });
  }, [pendingRestart, pendingRestartReasons, showDesktopNotification]);

  const completeResetLocalStateAfterServerWipe = useCallback(
    async (postResetAgentStatus: AgentStatus | null): Promise<void> => {
      await runCompleteResetLocalStateAfterServerWipe(postResetAgentStatus, {
        setAgentStatus,
        resetClientConnection: () => client.resetConnection(),
        clearPersistedActiveServer,
        clearPersistedAvatarIndex: clearAvatarIndex,
        setClientBaseUrl: (url) => client.setBaseUrl(url),
        setClientToken: (token) => client.setToken(token),
        clearElizaCloudSessionUi: () => {
          elizaCloudPreferDisconnectedUntilLoginRef.current = false;
          setElizaCloudEnabled(false);
          setElizaCloudConnected(false);
          publishElizaCloudVoiceSnapshot(
            setElizaCloudVoiceProxyAvailable,
            setElizaCloudHasPersistedKey,
            {
              apiConnected: false,
              enabled: false,
              cloudVoiceProxyAvailable: false,
              hasPersistedApiKey: false,
            },
          );
          setElizaCloudCredits(null);
          setElizaCloudCreditsLow(false);
          setElizaCloudCreditsCritical(false);
          setElizaCloudAuthRejected(false);
          setElizaCloudCreditsError(null);
          setElizaCloudTopUpUrl("/cloud/billing");
          setElizaCloudUserId(null);
          setElizaCloudStatusReason(null);
          setElizaCloudLoginError(null);
          // Clear the global cloud token so directCloudRequest stops firing
          // against api.elizacloud.ai with a stale key after reset. Without
          // this, the renderer keeps making direct cloud calls even though
          // the UI shows disconnected.
          //
          // Coupling guarantee: this runs in `clearElizaCloudSessionUi`,
          // which `complete-reset-local-state-after-wipe.ts` calls on
          // line 43 — immediately before `markOnboardingReset()` on
          // line 44. The two callbacks always fire as a pair, so the
          // token clear happens on every reset path that uses the
          // shared cascade. (The cascade is the sole caller; there
          // is no path that calls one without the other.)
          if (typeof globalThis !== "undefined") {
            try {
              delete (globalThis as Record<string, unknown>)
                .__ELIZA_CLOUD_AUTH_TOKEN__;
            } catch {
              (
                globalThis as Record<string, unknown>
              ).__ELIZA_CLOUD_AUTH_TOKEN__ = undefined;
            }
          }
        },
        markOnboardingReset: () => {
          enableForceFreshOnboarding();
          onboardingCompletionCommittedRef.current = false;
          setOnboardingUiRevealNonce((n) => n + 1);
          setOnboardingLoading(false);
          setOnboardingComplete(false);
          setOnboardingStep("deployment");
          setOnboardingMode("basic");
          setOnboardingActiveGuide(null);
          setOnboardingDeferredTasks([]);
          setPostOnboardingChecklistDismissed(false);
          setOnboardingName(defaultOnboardingStyle.name);
          setOnboardingStyle(defaultOnboardingStyle.id);
          persistMobileRuntimeModeForServerTarget("");
          setOnboardingServerTarget("");
          setOnboardingProvider("");
          setOnboardingApiKey("");
          setOnboardingVoiceProvider("");
          setOnboardingVoiceApiKey("");
          setOnboardingPrimaryModel("");
          setOnboardingOpenRouterModel("");
          setOnboardingRemoteConnected(false);
          setOnboardingRemoteApiBase("");
          setOnboardingRemoteToken("");
          setOnboardingSmallModel("");
          setOnboardingLargeModel("");
          // Return to splash so user can re-onboard from scratch
          coordinatorResetRef.current?.();
        },
        resetAvatarSelection: () => {
          setSelectedVrmIndex(defaultOnboardingStyle.avatarIndex);
          setCustomVrmUrl("");
          setCustomBackgroundUrl("");
        },
        clearConversationLists: () => {
          setConversationMessages([]);
          setActiveConversationId(null);
          activeConversationIdRef.current = null;
          setConversations([]);
          setPlugins([]);
          setSkills([]);
          setLogs([]);
        },
        fetchOnboardingOptions: () => client.getOnboardingOptions(),
        setOnboardingOptions,
        logResetDebug,
        logResetWarn,
      });
    },
    [
      setAgentStatus,
      setOnboardingComplete,
      setOnboardingLoading,
      setOnboardingOptions,
      setOnboardingStep,
      setOnboardingMode,
      setOnboardingActiveGuide,
      setOnboardingDeferredTasks,
      setPostOnboardingChecklistDismissed,
      setOnboardingName,
      setOnboardingStyle,
      setOnboardingServerTarget,
      setOnboardingProvider,
      setOnboardingApiKey,
      setOnboardingVoiceProvider,
      setOnboardingVoiceApiKey,
      setOnboardingPrimaryModel,
      setOnboardingOpenRouterModel,
      setOnboardingRemoteConnected,
      setOnboardingRemoteApiBase,
      setOnboardingRemoteToken,
      setOnboardingSmallModel,
      setOnboardingLargeModel,
      setOnboardingUiRevealNonce,
      setConversationMessages,
      setActiveConversationId,
      setConversations,
      setPlugins,
      setSkills,
      setLogs,
      activeConversationIdRef,
      onboardingCompletionCommittedRef,
      elizaCloudPreferDisconnectedUntilLoginRef,
      setElizaCloudEnabled,
      setElizaCloudConnected,
      setElizaCloudVoiceProxyAvailable,
      setElizaCloudHasPersistedKey,
      setElizaCloudCredits,
      setElizaCloudCreditsLow,
      setElizaCloudCreditsCritical,
      setElizaCloudAuthRejected,
      setElizaCloudCreditsError,
      setElizaCloudTopUpUrl,
      setElizaCloudUserId,
      setElizaCloudStatusReason,
      setElizaCloudLoginError,
      setSelectedVrmIndex,
      setCustomVrmUrl,
      setCustomBackgroundUrl,
      defaultOnboardingStyle, // Return to splash so user can re-onboard from scratch
      coordinatorResetRef.current,
    ],
  );

  const handleResetAppliedFromMain = useCallback(
    async (payload: unknown) => {
      await handleResetAppliedFromMainCore(payload, {
        performanceNow: () => performance.now(),
        isLifecycleBusy: () => lifecycleBusyRef.current,
        getActiveLifecycleAction: () =>
          lifecycleActionRef.current ?? lifecycleAction ?? "reset",
        beginLifecycleAction,
        finishLifecycleAction,
        setActionNotice,
        parseTrayResetPayload: parseAgentStatusFromMainMenuResetPayload,
        completeResetLocalState: completeResetLocalStateAfterServerWipe,
        alertDesktopMessage,
        logResetInfo,
        logResetWarn,
      });
    },
    [
      lifecycleAction,
      beginLifecycleAction,
      finishLifecycleAction,
      setActionNotice,
      completeResetLocalStateAfterServerWipe,
      lifecycleActionRef.current,
      lifecycleBusyRef.current,
    ],
  );

  const handleReset = useCallback(async () => {
    logResetInfo("handleReset: invoked");
    if (lifecycleBusyRef.current) {
      const activeAction =
        lifecycleActionRef.current ?? lifecycleAction ?? "reset";
      logResetInfo("handleReset: waiting for lifecycle to become idle", {
        activeAction,
      });
      setActionNotice(
        `Waiting for current agent action to finish (${LIFECYCLE_MESSAGES[activeAction].inProgress}).`,
        "info",
        12_000,
        false,
        true,
      );
      const idle = await waitForLifecycleIdle(lifecycleBusyRef, 10_000);
      if (!idle) {
        logResetInfo("handleReset: skipped — lifecycle remained busy", {
          activeAction,
        });
        setActionNotice(
          `Agent action already in progress (${LIFECYCLE_MESSAGES[activeAction].inProgress}). Please wait.`,
          "info",
          4200,
        );
        return;
      }
    }
    logResetInfo("handleReset: showing confirm dialog");
    const confirmed = await confirmDesktopAction({
      title: "Reset Agent",
      message:
        "This will reset the agent: config, cloud keys, and local agent database (conversations / memory).",
      detail:
        "Downloaded GGUF embedding models are kept. You will return to the onboarding wizard.",
      confirmLabel: "Reset",
      cancelLabel: "Cancel",
      type: "warning",
    });
    if (!confirmed) {
      logResetInfo("handleReset: cancelled by user");
      return;
    }
    // Native message boxes (Electrobun/macOS) can return without letting the webview
    // process network/RPC on the same turn — `fetch` and bridge requests then appear
    // to "never run" until something else wakes the loop. Yield once before reset work.
    logResetInfo(
      "handleReset: confirmed — scheduling reset on next event-loop turn (native dialog)",
    );
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), 0);
    });

    if (!beginLifecycleAction("reset")) {
      logResetInfo(
        "handleReset: beginLifecycleAction raced with another action — waiting",
      );
      const idle = await waitForLifecycleIdle(lifecycleBusyRef, 10_000);
      if (!idle || !beginLifecycleAction("reset")) {
        logResetInfo(
          "handleReset: forcing lifecycle lock clear after confirmed reset",
          {
            idle,
            activeAction: lifecycleActionRef.current,
          },
        );
        finishLifecycleAction();
        if (!beginLifecycleAction("reset")) {
          logResetInfo(
            "handleReset: aborted — could not begin lifecycle after forced clear",
          );
          setActionNotice(
            "Another agent operation is still running. Wait for it to finish, then try Reset again.",
            "info",
            4200,
          );
          return;
        }
      }
    }
    if (lifecycleActionRef.current !== "reset") {
      logResetInfo(
        "handleReset: lifecycle action ref was not reset after begin; continuing reset",
        { activeAction: lifecycleActionRef.current },
      );
    }
    setActionNotice(
      LIFECYCLE_MESSAGES.reset.progress,
      "info",
      120_000,
      false,
      true,
    );
    const resetStartedAt = performance.now();
    logResetInfo(
      "handleReset: starting (POST /api/agent/reset + restart path)",
      {
        electrobun: isElectrobunRuntime(),
        apiBase:
          client.getBaseUrl() || "(empty — will resolve after reconnect)",
      },
    );
    logResetInfo(
      "handleReset: tip — reset logs also appear in this window (filter [eliza][reset]); API terminal only shows server-side routes",
    );
    try {
      logResetDebug("handleReset: calling client.resetAgent()");
      await client.resetAgent();
      logResetDebug("handleReset: client.resetAgent() completed");
      logResetDebug(
        "handleReset: applying local UI reset before desktop restart wait",
      );
      await completeResetLocalStateAfterServerWipe(null);

      let postResetAgentStatus: AgentStatus | null = null;
      logResetDebug(
        "handleReset: invoking desktop bridge agentRestartClearLocalDb",
      );
      const BRIDGE_RESTART_MS = 150_000;
      try {
        postResetAgentStatus = await Promise.race([
          invokeDesktopBridgeRequest<AgentStatus>({
            rpcMethod: "agentRestartClearLocalDb",
            ipcChannel: "agent:restartClearLocalDb",
          }),
          new Promise<AgentStatus | null>((_, reject) => {
            window.setTimeout(() => {
              reject(
                Object.assign(
                  new Error(
                    `agentRestartClearLocalDb exceeded ${BRIDGE_RESTART_MS / 1000}s`,
                  ),
                  { name: "ResetBridgeTimeout" },
                ),
              );
            }, BRIDGE_RESTART_MS);
          }),
        ]);
        logResetDebug("handleReset: bridge agentRestartClearLocalDb settled", {
          hasResult: postResetAgentStatus != null,
          state: postResetAgentStatus?.state ?? null,
          port: postResetAgentStatus?.port ?? null,
        });
        if (postResetAgentStatus == null && isElectrobunRuntime()) {
          logResetWarn(
            "handleReset: agentRestartClearLocalDb RPC returned null — bridge request missing; will rely on HTTP restart path",
          );
        }
      } catch (bridgeErr) {
        postResetAgentStatus = null;
        if (
          bridgeErr instanceof Error &&
          bridgeErr.name === "ResetBridgeTimeout"
        ) {
          logResetWarn(
            "handleReset: agentRestartClearLocalDb timed out — falling back to HTTP restart",
            bridgeErr,
          );
        } else {
          logResetWarn(
            "handleReset: bridge agentRestartClearLocalDb threw (will try HTTP restart)",
            bridgeErr,
          );
        }
      }

      const embeddedRestartedOk =
        postResetAgentStatus != null &&
        (postResetAgentStatus.state === "running" ||
          postResetAgentStatus.state === "starting");

      logResetDebug("handleReset: embedded restart decision", {
        embeddedRestartedOk,
        bridgeState: postResetAgentStatus?.state ?? null,
      });

      if (!embeddedRestartedOk) {
        logResetInfo(
          "handleReset: calling client.restartAndWait(120s) — external API or bridge no-op",
        );
        try {
          postResetAgentStatus = await client.restartAndWait(120_000);
          logResetDebug("handleReset: restartAndWait completed", {
            state: postResetAgentStatus.state,
            port: postResetAgentStatus.port,
          });
          setAgentStatus(postResetAgentStatus);
        } catch (httpErr) {
          postResetAgentStatus = null;
          logResetWarn(
            "handleReset: client.restartAndWait failed — UI may be stale until manual restart",
            httpErr,
          );
        }
      }

      if (postResetAgentStatus != null) {
        setAgentStatus(postResetAgentStatus);
      }
      const elapsedMs = Math.round(performance.now() - resetStartedAt);
      logResetInfo(
        "handleReset: success — local UI reset; see server logs for API",
        {
          elapsedMs,
          finalAgentState: postResetAgentStatus?.state ?? null,
        },
      );
      setActionNotice(LIFECYCLE_MESSAGES.reset.success, "success", 3200);
    } catch (err) {
      logResetWarn("handleReset: failed before local UI could reset", err);
      setActionNotice(
        `Failed to ${LIFECYCLE_MESSAGES.reset.verb} agent: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
        "error",
        4200,
      );
      await alertDesktopMessage({
        title: "Reset Failed",
        message: "Reset failed. Check the console for details.",
        type: "error",
      });
    } finally {
      finishLifecycleAction();
    }
  }, [
    lifecycleAction,
    beginLifecycleAction,
    finishLifecycleAction,
    setActionNotice,
    setAgentStatus,
    completeResetLocalStateAfterServerWipe,
    lifecycleActionRef,
    lifecycleBusyRef,
  ]);

  return {
    handleStartDraftConversation,
    handleStart,
    handleStop,
    handleRestart,
    triggerRestart,
    retryBackendConnection,
    restartBackend,
    relaunchDesktop,
    showDesktopNotification,
    notifyAssistantEvent,
    notifyHeartbeatEvent,
    completeResetLocalStateAfterServerWipe,
    handleResetAppliedFromMain,
    handleReset,
  };
}
