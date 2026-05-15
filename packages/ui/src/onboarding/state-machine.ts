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
  language: string;
  name?: string;
  location?: string;
  history: OnboardingStateId[];
}

export type OnboardingEvent =
  | { type: "BEGIN" }
  | { type: "CHOOSE_RUNTIME"; runtime: RuntimeChoice }
  | { type: "CHOOSE_SANDBOX"; mode: SandboxMode }
  | { type: "CHOOSE_DEVICE_PATH"; path: DevicePath }
  | { type: "CONTINUE" }
  | { type: "BACK" }
  | { type: "SKIP" }
  | { type: "CONNECT_CLOUD" }
  | { type: "PAIR_REMOTE" }
  | { type: "LOCAL_DOWNLOAD_READY" }
  | { type: "JUMP"; to: OnboardingStateId }
  | { type: "SET_LANGUAGE"; language: string }
  | { type: "SET_NAME"; name: string }
  | { type: "SET_LOCATION"; location: string }
  | { type: "PICK_TUTORIAL"; next: "subscriptions" | "views" };

export const initialState: OnboardingFlowState = {
  current: "hello",
  language: "en-US",
  history: [],
};

function pushHistory(
  state: OnboardingFlowState,
  next: OnboardingStateId,
): OnboardingFlowState {
  if (next === state.current) return state;
  return {
    ...state,
    current: next,
    history: [...state.history, state.current],
  };
}

function popHistory(state: OnboardingFlowState): OnboardingFlowState {
  if (state.history.length === 0) return state;
  const previous = state.history[state.history.length - 1] as OnboardingStateId;
  return {
    ...state,
    current: previous,
    history: state.history.slice(0, -1),
  };
}

function continueFrom(state: OnboardingFlowState): OnboardingFlowState {
  switch (state.current) {
    case "hello":
      return pushHistory(state, "setup");
    case "setup": {
      if (state.runtime === "cloud") return pushHistory(state, "cloud-login");
      if (state.runtime === "remote") return pushHistory(state, "remote-pair");
      if (state.runtime === "device") {
        return pushHistory(state, "device-security");
      }
      return pushHistory(state, "cloud-login");
    }
    case "cloud-login":
      return pushHistory(state, "cloud-chat");
    case "cloud-chat":
      return pushHistory(state, "home");
    case "remote-pair":
      return pushHistory(state, "mic");
    case "device-security":
      return pushHistory(state, "device-mode");
    case "device-mode": {
      if (state.devicePath === "local-cloud") {
        return pushHistory(state, "cloud-login");
      }
      if (state.devicePath === "local-only") {
        return pushHistory(state, "local-download");
      }
      return pushHistory(state, "local-download");
    }
    case "local-download":
      return pushHistory(state, "mic");
    case "mic":
      return pushHistory(state, "profile-name");
    case "profile-name":
      return pushHistory(state, "profile-location");
    case "profile-location":
      return pushHistory(state, "tutorial-settings");
    case "tutorial-settings":
      return pushHistory(state, "tutorial-views");
    case "tutorial-subscriptions":
      return pushHistory(state, "tutorial-views");
    case "tutorial-views":
      return pushHistory(state, "tutorial-connectors");
    case "tutorial-connectors":
      return pushHistory(state, "tutorial-permissions");
    case "tutorial-permissions":
      return pushHistory(state, "home");
    case "home":
      return state;
    default:
      return state;
  }
}

function skipFrom(state: OnboardingFlowState): OnboardingFlowState {
  switch (state.current) {
    case "mic":
      return pushHistory(state, "profile-name");
    case "profile-name":
      return pushHistory(state, "profile-location");
    case "profile-location":
      return pushHistory(state, "tutorial-settings");
    case "tutorial-settings":
    case "tutorial-subscriptions":
    case "tutorial-views":
    case "tutorial-connectors":
    case "tutorial-permissions":
      return pushHistory(state, "home");
    default:
      return continueFrom(state);
  }
}

export function reduce(
  state: OnboardingFlowState,
  event: OnboardingEvent,
): OnboardingFlowState {
  switch (event.type) {
    case "BEGIN":
      return pushHistory(state, "setup");
    case "CHOOSE_RUNTIME":
      return { ...state, runtime: event.runtime };
    case "CHOOSE_SANDBOX":
      return { ...state, sandboxMode: event.mode };
    case "CHOOSE_DEVICE_PATH":
      return { ...state, devicePath: event.path };
    case "CONTINUE":
      return continueFrom(state);
    case "BACK":
      return popHistory(state);
    case "SKIP":
      return skipFrom(state);
    case "CONNECT_CLOUD":
      return pushHistory({ ...state, runtime: "cloud" }, "cloud-chat");
    case "PAIR_REMOTE":
      return pushHistory({ ...state, runtime: "remote" }, "mic");
    case "LOCAL_DOWNLOAD_READY":
      return state;
    case "JUMP":
      return pushHistory(state, event.to);
    case "SET_LANGUAGE":
      return { ...state, language: event.language };
    case "SET_NAME":
      return { ...state, name: event.name };
    case "SET_LOCATION":
      return { ...state, location: event.location };
    case "PICK_TUTORIAL":
      return pushHistory(
        state,
        event.next === "subscriptions"
          ? "tutorial-subscriptions"
          : "tutorial-views",
      );
    default:
      return state;
  }
}
