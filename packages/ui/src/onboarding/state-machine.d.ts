import type { OnboardingHardwareAdvice } from "../services/local-inference/hardware";
export type OnboardingStateId =
  | "hello"
  | "setup"
  | "cloud-login"
  | "cloud-chat"
  | "remote-pair"
  | "device-security"
  | "device-mode"
  | "local-download"
  | "mic"
  | "profile-name"
  | "profile-location"
  | "tutorial-settings"
  | "tutorial-subscriptions"
  | "tutorial-views"
  | "tutorial-connectors"
  | "tutorial-permissions"
  | "home";
export type RuntimeChoice = "cloud" | "device" | "remote";
export type SandboxMode = "sandbox" | "unsandboxed";
export type DevicePath = "local-cloud" | "local-only";
export interface OnboardingFlowState {
  current: OnboardingStateId;
  runtime?: RuntimeChoice;
  sandboxMode?: SandboxMode;
  devicePath?: DevicePath;
  cloudProvisioningStarted?: boolean;
  cloudAgentReady?: boolean;
  cloudConversationPushed?: boolean;
  localDownloadStarted?: boolean;
  localDownloadReady?: boolean;
  hardwareAdvice?: OnboardingHardwareAdvice | null;
  blocker?: string;
  language: string;
  name?: string;
  location?: string;
  history: OnboardingStateId[];
}
export type OnboardingEvent =
  | {
      type: "BEGIN";
    }
  | {
      type: "CHOOSE_RUNTIME";
      runtime: RuntimeChoice;
    }
  | {
      type: "CHOOSE_SANDBOX";
      mode: SandboxMode;
    }
  | {
      type: "CHOOSE_DEVICE_PATH";
      path: DevicePath;
    }
  | {
      type: "CONTINUE";
    }
  | {
      type: "BACK";
    }
  | {
      type: "SKIP";
    }
  | {
      type: "CONNECT_CLOUD";
    }
  | {
      type: "START_CLOUD_PROVISIONING";
    }
  | {
      type: "CLOUD_AGENT_READY";
    }
  | {
      type: "CLOUD_CONVERSATION_PUSHED";
    }
  | {
      type: "PAIR_REMOTE";
    }
  | {
      type: "START_LOCAL_DOWNLOAD";
    }
  | {
      type: "LOCAL_DOWNLOAD_READY";
    }
  | {
      type: "LOCAL_DOWNLOAD_INTERRUPTED";
    }
  | {
      type: "LOCAL_HARDWARE_ADVICE";
      advice: OnboardingHardwareAdvice;
    }
  | {
      type: "CLOUD_FALLBACK_REQUESTED";
    }
  | {
      type: "ONBOARDING_END_BLOCKED";
      reason: string;
    }
  | {
      type: "JUMP";
      to: OnboardingStateId;
    }
  | {
      type: "SET_LANGUAGE";
      language: string;
    }
  | {
      type: "SET_NAME";
      name: string;
    }
  | {
      type: "SET_LOCATION";
      location: string;
    }
  | {
      type: "PICK_TUTORIAL";
      next: "subscriptions" | "views";
    };
export declare const initialState: OnboardingFlowState;
export declare function reduce(
  state: OnboardingFlowState,
  event: OnboardingEvent,
): OnboardingFlowState;
//# sourceMappingURL=state-machine.d.ts.map
