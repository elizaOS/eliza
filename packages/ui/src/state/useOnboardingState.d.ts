/**
 * Onboarding state — consolidated via useReducer.
 *
 * Replaces 35+ individual useState hooks with structured reducers.
 * Connector tokens (telegram, discord, etc.) collapse into a single Record.
 * Remote connection state (connecting/connected/error) collapses into one object.
 */
import type { OnboardingOptions } from "../api";
import { type OnboardingServerTarget } from "../onboarding/server-target";
import type { AppState, OnboardingStep } from "./types";
export type ConnectorTokenKey =
  | "telegramToken"
  | "discordToken"
  | "whatsAppSessionPath"
  | "twilioAccountSid"
  | "twilioAuthToken"
  | "twilioPhoneNumber"
  | "blooioApiKey"
  | "blooioPhoneNumber"
  | "githubToken";
export interface RemoteConnectionState {
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
}
export interface OnboardingState {
  step: OnboardingStep;
  mode: AppState["onboardingMode"];
  activeGuide: string | null;
  deferredTasks: string[];
  postChecklistDismissed: boolean;
  options: OnboardingOptions | null;
  name: string;
  ownerName: string;
  style: string;
  avatar: number;
  serverTarget: OnboardingServerTarget;
  cloudApiKey: string;
  provider: string;
  apiKey: string;
  voiceProvider: string;
  voiceApiKey: string;
  nanoModel: string;
  smallModel: string;
  mediumModel: string;
  largeModel: string;
  megaModel: string;
  openRouterModel: string;
  primaryModel: string;
  existingInstallDetected: boolean;
  detectedProviders: AppState["onboardingDetectedProviders"];
  connectorTokens: Record<ConnectorTokenKey, string>;
  remote: RemoteConnectionState;
  remoteApiBase: string;
  remoteToken: string;
  subscriptionTab: "token" | "oauth";
  elizaCloudTab: "login" | "apikey";
  selectedChains: Set<string>;
  rpcSelections: Record<string, string>;
  rpcKeys: Record<string, string>;
  featureTelegram: boolean;
  featureDiscord: boolean;
  featurePhone: boolean;
  featureCrypto: boolean;
  featureBrowser: boolean;
  featureComputerUse: boolean;
  featureOAuthPending: string | null;
  restarting: boolean;
  cloudProvisionedContainer: boolean;
}
type OnboardingAction =
  | {
      type: "SET_STEP";
      step: OnboardingStep;
    }
  | {
      type: "SET_MODE";
      mode: AppState["onboardingMode"];
    }
  | {
      type: "SET_ACTIVE_GUIDE";
      guide: string | null;
    }
  | {
      type: "ADD_DEFERRED_TASK";
      task: string;
    }
  | {
      type: "SET_DEFERRED_TASKS";
      tasks: string[];
    }
  | {
      type: "SET_POST_CHECKLIST_DISMISSED";
      value: boolean;
    }
  | {
      type: "SET_OPTIONS";
      options: OnboardingOptions | null;
    }
  | {
      type: "SET_FIELD";
      field: string;
      value: unknown;
    }
  | {
      type: "SET_CONNECTOR_TOKEN";
      key: ConnectorTokenKey;
      value: string;
    }
  | {
      type: "SET_REMOTE_STATUS";
      status: RemoteConnectionState["status"];
      error?: string | null;
    }
  | {
      type: "SET_REMOTE_API_BASE";
      value: string;
    }
  | {
      type: "SET_REMOTE_TOKEN";
      value: string;
    }
  | {
      type: "SET_DETECTED_PROVIDERS";
      value: AppState["onboardingDetectedProviders"];
    }
  | {
      type: "RESET_FOR_NEW_ONBOARDING";
    };
export interface OnboardingStateHook {
  state: OnboardingState;
  dispatch: React.Dispatch<OnboardingAction>;
  setStep: (step: OnboardingStep) => void;
  setMode: (mode: AppState["onboardingMode"]) => void;
  setActiveGuide: (guide: string | null) => void;
  addDeferredTask: (task: string) => void;
  setDeferredTasks: (tasks: string[]) => void;
  setOptions: (options: OnboardingOptions | null) => void;
  setField: (field: string, value: unknown) => void;
  setConnectorToken: (key: ConnectorTokenKey, value: string) => void;
  setRemoteStatus: (
    status: RemoteConnectionState["status"],
    error?: string | null,
  ) => void;
  setDetectedProviders: (
    value: AppState["onboardingDetectedProviders"],
  ) => void;
  /** Tracks whether onboarding completion has been committed this session. */
  completionCommittedRef: React.RefObject<boolean>;
  /** Force local bootstrap ref. */
  forceLocalBootstrapRef: React.RefObject<boolean>;
}
export declare function useOnboardingState(
  cloudOnly?: boolean,
): OnboardingStateHook;
export type { OnboardingAction as OnboardingDispatchAction };
//# sourceMappingURL=useOnboardingState.d.ts.map
