import type { SandboxMode } from "../../../onboarding/state-machine";

export interface StateDeviceSecurityProps {
  sandboxMode: SandboxMode | undefined;
  onChoose: (mode: SandboxMode) => void;
  onContinue: () => void;
  onBack: () => void;
}

export function StateDeviceSecurity(
  props: StateDeviceSecurityProps,
): React.JSX.Element {
  const { sandboxMode, onChoose, onContinue, onBack } = props;
  const selected = sandboxMode ?? "sandbox";
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="device-security"
    >
      <h1>On-Device</h1>
      <p>
        I recommend sandbox if this is your regular machine. Run without
        sandboxing if you want to give me full access.
      </p>
      <div className="eliza-ob-choice-list">
        <button
          type="button"
          className={`eliza-ob-choice${selected === "sandbox" ? " selected" : ""}`}
          onClick={() => onChoose("sandbox")}
        >
          <span className="eliza-ob-choice-top">
            <strong>Sandbox</strong>
            <span className="eliza-ob-chip">Default</span>
          </span>
          <span>Recommended for your regular machine.</span>
        </button>
        <button
          type="button"
          className={`eliza-ob-choice${selected === "unsandboxed" ? " selected" : ""}`}
          onClick={() => onChoose("unsandboxed")}
        >
          <strong>No sandbox</strong>
          <span>Advanced users only. Gives Eliza broader access.</span>
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
