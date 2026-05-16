export interface StateTutorialViewsProps {
  onContinue: () => void;
}

export function StateTutorialViews(
  props: StateTutorialViewsProps,
): React.JSX.Element {
  const { onContinue } = props;
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="tutorial-views"
    >
      <h1>Views</h1>
      <div className="eliza-ob-tutorial-card">
        <div className="eliza-ob-mini-screen">
          <div className="eliza-ob-mini-row">
            Chat <span className="eliza-ob-mini-pill">default</span>
          </div>
          <div className="eliza-ob-mini-row">
            Character <span>Edit avatar</span>
          </div>
          <div className="eliza-ob-mini-row">
            Automations <span>Tasks</span>
          </div>
          <div className="eliza-ob-mini-row">
            Settings <span>Config</span>
          </div>
        </div>
        <p>
          All your views are here. Views are ways for me to show you a look into
          my mind. You can build anything you want, and it will get added here.
        </p>
      </div>
      <div className="eliza-ob-footer">
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
