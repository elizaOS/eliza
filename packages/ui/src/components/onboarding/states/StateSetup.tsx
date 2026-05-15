import type { RuntimeChoice } from "../../../onboarding/state-machine";
import { type DeviceProfile, deviceProfileCopy } from "./device-profiles";

export interface StateSetupProps {
  deviceProfile: DeviceProfile;
  runtime: RuntimeChoice | undefined;
  language: string;
  onLanguageChange: (language: string) => void;
  onChooseRuntime: (runtime: RuntimeChoice) => void;
  onContinue: () => void;
  onChooseRemote: () => void;
}

const LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "en-US", label: "🇺🇸 English" },
  { value: "es-ES", label: "🇪🇸 Spanish" },
  { value: "ja-JP", label: "🇯🇵 Japanese" },
  { value: "ko-KR", label: "🇰🇷 Korean" },
];

export function StateSetup(props: StateSetupProps): JSX.Element {
  const {
    deviceProfile,
    runtime,
    language,
    onLanguageChange,
    onChooseRuntime,
    onContinue,
    onChooseRemote,
  } = props;
  const copy = deviceProfileCopy(deviceProfile);
  const selected = runtime ?? (copy.preferLocal ? "device" : "cloud");

  return (
    <section className="eliza-ob-screen centered" data-eliza-ob-state="setup">
      <div className="eliza-ob-language">
        <select
          aria-label="Language"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>
      <h1>Setup Your Eliza</h1>
      <div className="eliza-ob-runtime-intro">
        <strong>Let's get set up.</strong>
        <span className="eliza-ob-recommendation-copy">
          {copy.recommendation}
        </span>
      </div>
      <div className="eliza-ob-choice-list">
        <button
          type="button"
          className={`eliza-ob-choice${selected === "cloud" ? " selected" : ""}`}
          onClick={() => onChooseRuntime("cloud")}
        >
          <span className="eliza-ob-choice-top">
            <strong>Cloud</strong>
            <span className="eliza-ob-chip">Recommended</span>
          </span>
          <span>
            Sign in, talk immediately, and move into your container when it is
            ready.
          </span>
        </button>
        <button
          type="button"
          className={`eliza-ob-choice${selected === "device" ? " selected" : ""}`}
          onClick={() => onChooseRuntime("device")}
        >
          <strong>On-Device</strong>
          <span>
            Download the preferred Eliza-1 model and run on this device.
          </span>
        </button>
      </div>
      <div className="eliza-ob-footer vertical">
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={onContinue}
        >
          Continue
        </button>
        <button
          type="button"
          className="eliza-ob-btn text-only"
          onClick={onChooseRemote}
        >
          Connect To Remote Instance
        </button>
      </div>
    </section>
  );
}
