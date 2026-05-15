export interface StateTutorialConnectorsProps {
  onContinue: () => void;
}

export function StateTutorialConnectors(
  props: StateTutorialConnectorsProps,
): JSX.Element {
  const { onContinue } = props;
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="tutorial-connectors"
    >
      <h1>Connectors</h1>
      <div className="eliza-ob-tutorial-card">
        <div className="eliza-ob-mini-screen">
          <div className="eliza-ob-mini-row">
            Google Calendar <span>Read events</span>
          </div>
          <div className="eliza-ob-mini-row">
            Gmail <span>Read mail</span>
          </div>
          <div className="eliza-ob-mini-row">
            Slack <span>Workspace context</span>
          </div>
        </div>
        <p>
          You can connect accounts for me to read data or use tools. Sending
          messages stays gated by permission.
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
