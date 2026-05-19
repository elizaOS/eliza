export interface StateTutorialSettingsProps {
  onHasSubscriptions: () => void;
  onContinue: () => void;
}

export function StateTutorialSettings(
  props: StateTutorialSettingsProps,
): React.JSX.Element {
  const { onHasSubscriptions, onContinue } = props;
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="tutorial-settings"
    >
      <h1>Settings</h1>
      <p>Mind if I show you around?</p>
      <div className="eliza-ob-tutorial-card">
        <div className="eliza-ob-mini-screen">
          <div className="eliza-ob-mini-row">
            Settings <span className="eliza-ob-mini-pill">open</span>
          </div>
          <div className="eliza-ob-mini-row">
            AI subscriptions <span>Add providers</span>
          </div>
          <div className="eliza-ob-mini-row">
            Profile <span>Name, home, timezone</span>
          </div>
        </div>
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn secondary"
          onClick={onHasSubscriptions}
        >
          I have AI subscriptions
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
