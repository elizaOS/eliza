import { useCallback, useMemo } from "react";
import { BackgroundHost } from "../../../backgrounds";
import {
  type OnboardingEvent,
  type OnboardingFlowState,
  type OnboardingStateId,
  reduce,
} from "../../../onboarding/state-machine";
import { useOnboardingPersisted } from "../../../onboarding/state-persistence";
import type { DeviceProfile } from "./device-profiles";
import { StateCloudChat } from "./StateCloudChat";
import { StateCloudLogin } from "./StateCloudLogin";
import { StateDeviceMode } from "./StateDeviceMode";
import { StateDeviceSecurity } from "./StateDeviceSecurity";
import { StateHello } from "./StateHello";
import {
  type LocalDownloadProgress,
  StateLocalDownload,
} from "./StateLocalDownload";
import { StateMic } from "./StateMic";
import { StateProfileLocation } from "./StateProfileLocation";
import { StateProfileName } from "./StateProfileName";
import { StateRemotePair } from "./StateRemotePair";
import { StateSetup } from "./StateSetup";
import { StateTutorialConnectors } from "./StateTutorialConnectors";
import { StateTutorialPermissions } from "./StateTutorialPermissions";
import { StateTutorialSettings } from "./StateTutorialSettings";
import { StateTutorialSubscriptions } from "./StateTutorialSubscriptions";
import { StateTutorialViews } from "./StateTutorialViews";

import "./onboarding.css";

export interface OnboardingRootProps {
  deviceProfile?: DeviceProfile;
  localDownloadProgress?: LocalDownloadProgress;
  onComplete?: (state: OnboardingFlowState) => void;
  onStateChange?: (state: OnboardingFlowState) => void;
  initialStateId?: OnboardingStateId;
}

export function OnboardingRoot(props: OnboardingRootProps): JSX.Element {
  const {
    deviceProfile = "ios",
    localDownloadProgress,
    onComplete,
    onStateChange,
    initialStateId,
  } = props;
  const { state, setState } = useOnboardingPersisted();

  const dispatch = useCallback(
    (event: OnboardingEvent): OnboardingFlowState => {
      const next = reduce(state, event);
      setState(next);
      onStateChange?.(next);
      if (next.current === "home" && state.current !== "home") {
        onComplete?.(next);
      }
      return next;
    },
    [state, setState, onStateChange, onComplete],
  );

  const current = useMemo<OnboardingStateId>(
    () => initialStateId ?? state.current,
    [initialStateId, state.current],
  );

  const node = useMemo(
    () =>
      renderState(current, state, dispatch, {
        deviceProfile,
        localDownloadProgress,
      }),
    [current, state, dispatch, deviceProfile, localDownloadProgress],
  );

  return (
    <div className="eliza-ob" data-eliza-ob-root="">
      <BackgroundHost />
      {node}
    </div>
  );
}

interface RenderOpts {
  deviceProfile: DeviceProfile;
  localDownloadProgress?: LocalDownloadProgress;
}

function renderState(
  current: OnboardingStateId,
  state: OnboardingFlowState,
  dispatch: (event: OnboardingEvent) => OnboardingFlowState,
  opts: RenderOpts,
): JSX.Element {
  switch (current) {
    case "hello":
      return <StateHello onBegin={() => dispatch({ type: "BEGIN" })} />;
    case "setup":
      return (
        <StateSetup
          deviceProfile={opts.deviceProfile}
          runtime={state.runtime}
          language={state.language}
          onLanguageChange={(language) =>
            dispatch({ type: "SET_LANGUAGE", language })
          }
          onChooseRuntime={(runtime) =>
            dispatch({ type: "CHOOSE_RUNTIME", runtime })
          }
          onContinue={() => dispatch({ type: "CONTINUE" })}
          onChooseRemote={() => {
            dispatch({ type: "CHOOSE_RUNTIME", runtime: "remote" });
            dispatch({ type: "CONTINUE" });
          }}
        />
      );
    case "cloud-login":
      return (
        <StateCloudLogin
          onConnect={() => dispatch({ type: "CONTINUE" })}
          onBack={() => dispatch({ type: "BACK" })}
        />
      );
    case "cloud-chat":
      return (
        <StateCloudChat onEnterChat={() => dispatch({ type: "CONTINUE" })} />
      );
    case "remote-pair":
      return (
        <StateRemotePair
          onPair={() => dispatch({ type: "PAIR_REMOTE" })}
          onBack={() => dispatch({ type: "BACK" })}
        />
      );
    case "device-security":
      return (
        <StateDeviceSecurity
          sandboxMode={state.sandboxMode}
          onChoose={(mode) => dispatch({ type: "CHOOSE_SANDBOX", mode })}
          onContinue={() => dispatch({ type: "CONTINUE" })}
          onBack={() => dispatch({ type: "BACK" })}
        />
      );
    case "device-mode":
      return (
        <StateDeviceMode
          devicePath={state.devicePath}
          onChoose={(path) => dispatch({ type: "CHOOSE_DEVICE_PATH", path })}
          onContinue={() => dispatch({ type: "CONTINUE" })}
          onBack={() => dispatch({ type: "BACK" })}
        />
      );
    case "local-download":
      return (
        <StateLocalDownload
          progress={opts.localDownloadProgress}
          onUseCloudInstead={() => {
            dispatch({ type: "CHOOSE_RUNTIME", runtime: "cloud" });
            dispatch({ type: "JUMP", to: "cloud-login" });
          }}
          onContinue={() => dispatch({ type: "CONTINUE" })}
          onReady={() => dispatch({ type: "LOCAL_DOWNLOAD_READY" })}
        />
      );
    case "mic":
      return (
        <StateMic
          onContinue={() => dispatch({ type: "CONTINUE" })}
          onSkip={() => dispatch({ type: "SKIP" })}
        />
      );
    case "profile-name":
      return (
        <StateProfileName
          initialName={state.name}
          onContinue={(name) => {
            dispatch({ type: "SET_NAME", name });
            dispatch({ type: "CONTINUE" });
          }}
        />
      );
    case "profile-location":
      return (
        <StateProfileLocation
          initialLocation={state.location}
          onContinue={(location) => {
            dispatch({ type: "SET_LOCATION", location });
            dispatch({ type: "CONTINUE" });
          }}
        />
      );
    case "tutorial-settings":
      return (
        <StateTutorialSettings
          onHasSubscriptions={() =>
            dispatch({ type: "PICK_TUTORIAL", next: "subscriptions" })
          }
          onContinue={() => dispatch({ type: "CONTINUE" })}
        />
      );
    case "tutorial-subscriptions":
      return (
        <StateTutorialSubscriptions
          onContinue={() => dispatch({ type: "CONTINUE" })}
        />
      );
    case "tutorial-views":
      return (
        <StateTutorialViews onContinue={() => dispatch({ type: "CONTINUE" })} />
      );
    case "tutorial-connectors":
      return (
        <StateTutorialConnectors
          onContinue={() => dispatch({ type: "CONTINUE" })}
        />
      );
    case "tutorial-permissions":
      return (
        <StateTutorialPermissions
          onFinish={() => dispatch({ type: "CONTINUE" })}
        />
      );
    case "home":
      return (
        <section
          className="eliza-ob-screen centered"
          data-eliza-ob-state="home"
        >
          <h1>You're all set</h1>
          <p>Continue into the companion shell.</p>
        </section>
      );
    default:
      return (
        <section className="eliza-ob-screen centered">
          <p>Unknown state.</p>
        </section>
      );
  }
}
