import { useState } from "react";
import { OnboardingAvatar } from "./OnboardingAvatar";

export interface StateProfileLocationProps {
  transcript?: string;
  initialLocation?: string;
  onContinue: (location: string) => void;
}

export function StateProfileLocation(
  props: StateProfileLocationProps,
): React.JSX.Element {
  const { transcript, initialLocation, onContinue } = props;
  const [location, setLocation] = useState(initialLocation ?? "");
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="profile-location"
    >
      <div className="eliza-ob-agent">
        <OnboardingAvatar />
        <div className="eliza-ob-transcript">
          {transcript ??
            "Where do you live? I can use that to set your time and time zone."}
        </div>
      </div>
      <div className="eliza-ob-form">
        <input
          className="eliza-ob-input"
          placeholder="City, region, or country"
          autoComplete="address-level2"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
        />
      </div>
      <div className="eliza-ob-runtime-intro">
        <strong>AOSP and Linux</strong>
        <span>
          Eliza can set system time and time zone from this during device setup.
        </span>
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={() => onContinue(location)}
        >
          Continue
        </button>
      </div>
    </section>
  );
}
