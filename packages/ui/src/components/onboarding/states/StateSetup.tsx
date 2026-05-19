import { appNameInterpolationVars, useBranding } from "../../../config/branding";
import { t } from "../../../i18n";
import type { RuntimeChoice } from "../../../onboarding/state-machine";
import { type DeviceProfile, deviceProfileCopy } from "./device-profiles";

export interface StateSetupProps {
  deviceProfile: DeviceProfile;
  runtime: RuntimeChoice | undefined;
  language: string;
  onLanguageChange: (language: string) => void;
  onChooseRuntime: (runtime: RuntimeChoice) => void;
  onContinue: (selectedRuntime: RuntimeChoice) => void;
  onChooseRemote: () => void;
}

// Languages identified by their native name rather than a flag emoji.
// Flags conflate language with country (English ≠ 🇺🇸, Spanish ≠ 🇪🇸), which
// excludes huge user populations and is a standard i18n anti-pattern.
const LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "en-US", label: "English" },
  { value: "zh-CN", label: "中文" },
  { value: "es-ES", label: "Español" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "pt-BR", label: "Português" },
  { value: "tl-PH", label: "Tagalog" },
  { value: "vi-VN", label: "Tiếng Việt" },
];

export function StateSetup(props: StateSetupProps): React.JSX.Element {
  const {
    deviceProfile,
    runtime,
    language,
    onLanguageChange,
    onChooseRuntime,
    onContinue,
    onChooseRemote,
  } = props;
  const branding = useBranding();
  const brandVars = appNameInterpolationVars(branding);
  const copy = deviceProfileCopy(deviceProfile);
  const selected = runtime ?? (copy.preferLocal ? "device" : "cloud");

  return (
    <section className="eliza-ob-screen centered" data-eliza-ob-state="setup">
      <div className="eliza-ob-language">
        <select
          aria-label={t(language, "onboarding.setup.languageLabel", {
            defaultValue: "Language",
          })}
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
      <h1>
        {t(language, "onboarding.setup.setupYourApp", {
          ...brandVars,
          defaultValue: "Setup Your {{appName}}",
        })}
      </h1>
      <div className="eliza-ob-runtime-intro">
        <span className="eliza-ob-recommendation-copy">
          {copy.recommendation}
        </span>
      </div>
      <h2 className="eliza-ob-runtime-prompt">
        {t(language, "onboarding.setup.whereShouldRun", {
          ...brandVars,
          defaultValue: "Where should {{appName}} run?",
        })}
      </h2>
      <div
        className="eliza-ob-choice-list"
        role="radiogroup"
        aria-label={t(language, "onboarding.setup.whereShouldRun", {
          ...brandVars,
          defaultValue: "Where {{appName}} should run",
        })}
      >
        <button
          type="button"
          role="radio"
          aria-checked={selected === "cloud"}
          className={`eliza-ob-choice${selected === "cloud" ? " selected" : ""}`}
          onClick={() => onChooseRuntime("cloud")}
        >
          <span className="eliza-ob-choice-top">
            <strong>Cloud</strong>
            <span className="eliza-ob-chip">Recommended</span>
          </span>
          <span>Sign in and start talking.</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={selected === "device"}
          className={`eliza-ob-choice${selected === "device" ? " selected" : ""}`}
          onClick={() => onChooseRuntime("device")}
        >
          <strong>On-Device</strong>
          <span>Run on this device.</span>
        </button>
      </div>
      <div className="eliza-ob-footer vertical">
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={() => onContinue(selected)}
        >
          Continue
        </button>
        <button
          type="button"
          className="eliza-ob-btn text-only"
          onClick={onChooseRemote}
        >
          Connect to a remote instance
        </button>
      </div>
    </section>
  );
}
