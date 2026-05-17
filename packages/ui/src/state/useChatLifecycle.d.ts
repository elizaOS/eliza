/**
 * Chat lifecycle callbacks — agent start/stop/restart/reset operations.
 *
 * Extracted from useChatCallbacks.ts. Handles all agent lifecycle transitions,
 * desktop notifications, and full-reset flows.
 */
import { type MutableRefObject } from "react";
import type {
  Conversation,
  ConversationMessage,
  OnboardingOptions,
} from "../api";
import { type AgentStatus, type StreamEventEnvelope } from "../api";
import type { AppState, LifecycleAction } from "./internal";
import type { OnboardingMode, OnboardingStep } from "./types";
export interface UseChatLifecycleDeps {
  agentStatus: AgentStatus | null;
  setAgentStatus: (s: AgentStatus | null) => void;
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
  pendingRestart: boolean;
  pendingRestartReasons: string[];
  setPendingRestart: (v: boolean) => void;
  setPendingRestartReasons: (
    v: string[] | ((prev: string[]) => string[]),
  ) => void;
  setBackendDisconnectedBannerDismissed: (v: boolean) => void;
  resetBackendConnection: () => void;
  loadConversations: () => Promise<Conversation[] | null>;
  loadPlugins: () => Promise<unknown>;
  hydrateInitialConversationState: () => Promise<string | null>;
  requestGreetingWhenRunning: (convId: string | null) => Promise<void>;
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
  setSelectedVrmIndex: (v: number) => void;
  setCustomVrmUrl: (v: string) => void;
  setCustomBackgroundUrl: (v: string) => void;
  setPlugins: (v: never[]) => void;
  setSkills: (v: never[]) => void;
  setLogs: (v: never[]) => void;
  coordinatorResetRef: MutableRefObject<(() => void) | null>;
}
export declare function useChatLifecycle(deps: UseChatLifecycleDeps): {
  handleStartDraftConversation: () => Promise<void>;
  handleStart: () => Promise<void>;
  handleStop: () => Promise<void>;
  handleRestart: () => Promise<void>;
  triggerRestart: () => Promise<void>;
  retryBackendConnection: () => void;
  restartBackend: () => Promise<void>;
  relaunchDesktop: () => Promise<void>;
  showDesktopNotification: (options: {
    title: string;
    body?: string;
    urgency?: "normal" | "critical" | "low";
    silent?: boolean;
  }) => Promise<void>;
  notifyAssistantEvent: (event: StreamEventEnvelope) => void;
  notifyHeartbeatEvent: (event: StreamEventEnvelope) => void;
  completeResetLocalStateAfterServerWipe: (
    postResetAgentStatus: AgentStatus | null,
  ) => Promise<void>;
  handleResetAppliedFromMain: (payload: unknown) => Promise<void>;
  handleReset: () => Promise<void>;
};
//# sourceMappingURL=useChatLifecycle.d.ts.map
