import type { DevicePath } from "../../../onboarding/state-machine";

export interface StateDeviceModeProps {
  devicePath: DevicePath | undefined;
  onChoose: (path: DevicePath) => void;
  onStartLocalModelDownload: () => void;
  onBack: () => void;
  onContinue: () => void;
}

export function StateDeviceMode(props: StateDeviceModeProps): React.JSX.Element {
  const {
    devicePath,
    onChoose,
    onStartLocalModelDownload,
    onBack,
    onContinue,
  } = props;
  const selected = devicePath ?? "local-cloud";
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="device-mode"
    >
      <h1>Local Runtime</h1>
      <p>You can run entirely locally or use Eliza Cloud.</p>
      <div className="eliza-ob-choice-list">
        <button
          type="button"
          className={`eliza-ob-choice${selected === "local-cloud" ? " selected" : ""}`}
          onClick={() => onChoose("local-cloud")}
        >
          <strong>Local + cloud services</strong>
          <span>
            Use local models where possible, with cloud for sync and extra
            capability.
          </span>
        </button>
        <button
          type="button"
          className={`eliza-ob-choice${selected === "local-only" ? " selected" : ""}`}
          onClick={() => {
            onChoose("local-only");
            onStartLocalModelDownload();
          }}
        >
          <strong>All local</strong>
          <span>Download models and keep the next phase on this device.</span>
        </button>
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn secondary"
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </section>
  );
}
