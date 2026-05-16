export interface StateTutorialPermissionsProps {
  onFinish: () => void;
  blocker?: string;
  onCheckLocalReady?: () => void;
}

export function StateTutorialPermissions(
  props: StateTutorialPermissionsProps,
): React.JSX.Element {
  const { onFinish, blocker, onCheckLocalReady } = props;
  const blocked = typeof blocker === "string" && blocker.length > 0;
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
      {blocked ? (
        <div
          className="eliza-ob-blocker"
          data-eliza-ob-blocker=""
          role="status"
        >
          <p>{blocker}</p>
          {onCheckLocalReady ? (
            <button
              type="button"
              className="eliza-ob-btn secondary"
              onClick={onCheckLocalReady}
            >
              Wait and try again
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={onFinish}
          disabled={blocked}
        >
          Finish
        </button>
      </div>
    </section>
  );
}
