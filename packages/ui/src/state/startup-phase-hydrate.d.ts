/**
 * startup-phase-hydrate.ts
 *
 * Side-effect logic for the "hydrating" startup phase and the persistent
 * "ready" phase (WebSocket bindings, nav listener).
 */
import type { AgentStatus, WalletAddresses } from "../api";
import {
  type CodingAgentSession,
  type Conversation,
  type ConversationMessage,
  type StreamEventEnvelope,
} from "../api";
import { type Tab } from "../navigation";
import type { StartupEvent } from "./startup-coordinator";
import type { OnboardingMode } from "./types";
export interface HydratingDeps {
  setStartupError: (v: null) => void;
  setOnboardingLoading: (v: boolean) => void;
  hydrateInitialConversationState: () => Promise<string | null>;
  requestGreetingWhenRunningRef: React.RefObject<
    (convId: string) => Promise<void>
  >;
  loadWorkbench: () => Promise<void>;
  loadPlugins: () => Promise<void>;
  loadSkills: () => Promise<void>;
  loadCharacter: () => Promise<void>;
  loadWalletConfig: () => Promise<void>;
  loadInventory: () => Promise<void>;
  loadUpdateStatus: (force?: boolean) => Promise<void>;
  checkExtensionStatus: () => Promise<void>;
  pollCloudCredits: () => void;
  fetchAutonomyReplay: () => Promise<void>;
  setSelectedVrmIndex: (v: number) => void;
  setCustomVrmUrl: (v: string) => void;
  setCustomBackgroundUrl: (v: string) => void;
  setWalletAddresses: (v: WalletAddresses) => void;
  setTab: (t: Tab) => void;
  setTabRaw: (t: Tab) => void;
  onboardingCompletionCommittedRef: React.MutableRefObject<boolean>;
  initialTabSetRef: React.MutableRefObject<boolean>;
  onboardingMode: OnboardingMode;
}
export interface ReadyPhaseDeps {
  setAgentStatusIfChanged: (v: AgentStatus) => void;
  setPendingRestart: (v: boolean | ((prev: boolean) => boolean)) => void;
  setPendingRestartReasons: (
    v: string[] | ((prev: string[]) => string[]),
  ) => void;
  setSystemWarnings: (v: string[] | ((prev: string[]) => string[])) => void;
  showRestartBanner: () => void;
  setPtySessions: (
    v:
      | CodingAgentSession[]
      | ((prev: CodingAgentSession[]) => CodingAgentSession[]),
  ) => void;
  /** Ref whose .current is true when there are active PTY sessions. */
  hasPtySessionsRef: React.MutableRefObject<boolean>;
  setTabRaw: (t: Tab) => void;
  setConversationMessages: (
    v:
      | ConversationMessage[]
      | ((prev: ConversationMessage[]) => ConversationMessage[]),
  ) => void;
  setUnreadConversations: (
    v: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => void;
  setConversations: (
    v: Conversation[] | ((prev: Conversation[]) => Conversation[]),
  ) => void;
  appendAutonomousEvent: (event: StreamEventEnvelope) => void;
  notifyAssistantEvent: (event: StreamEventEnvelope) => void;
  notifyHeartbeatEvent: (event: StreamEventEnvelope) => void;
  loadPlugins: () => Promise<void>;
  loadWalletConfig: () => Promise<void>;
  pollCloudCredits: () => void;
  activeConversationIdRef: React.RefObject<string | null>;
  elizaCloudPollInterval: React.MutableRefObject<number | null>;
  elizaCloudLoginPollTimer: React.MutableRefObject<number | null>;
}
/**
 * Runs the hydrating phase.
 * Loads initial conversation state, wallet, avatar, plugins, and sets the tab.
 * Dispatches HYDRATION_COMPLETE when done.
 */
export declare function runHydrating(
  deps: HydratingDeps,
  dispatch: (event: StartupEvent) => void,
  cancelled: {
    current: boolean;
  },
): Promise<void>;
/**
 * Sets up persistent WebSocket bindings and the navigation listener.
 * Returns a cleanup function that unbinds everything.
 * Should be called once when the coordinator first reaches "ready".
 */
export declare function bindReadyPhase(
  depsRef: React.MutableRefObject<ReadyPhaseDeps | undefined>,
): () => void;
//# sourceMappingURL=startup-phase-hydrate.d.ts.map
