export interface StateTutorialPermissionsProps {
  onFinish: () => void;
}

export function StateTutorialPermissions(
  props: StateTutorialPermissionsProps,
): JSX.Element {
  const { onFinish } = props;
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="tutorial-permissions"
    >
      <h1>Permissions</h1>
      <div className="eliza-ob-tutorial-card">
        <div className="eliza-ob-mini-screen">
          <div className="eliza-ob-mini-row">
            Files <span>Ask every time</span>
          </div>
          <div className="eliza-ob-mini-row">
            Messages <span>Never send without approval</span>
          </div>
          <div className="eliza-ob-mini-row">
            Microphone <span>Push to talk</span>
          </div>
        </div>
        <p>Only share what you're comfortable with.</p>
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={onFinish}
        >
          Finish
        </button>
      </div>
    </section>
  );
}
