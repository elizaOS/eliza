export interface StateTutorialSubscriptionsProps {
  onContinue: () => void;
}

export function StateTutorialSubscriptions(
  props: StateTutorialSubscriptionsProps,
): React.JSX.Element {
  const { onContinue } = props;
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="tutorial-subscriptions"
    >
      <h1>AI Subscriptions</h1>
      <div className="eliza-ob-tutorial-card">
        <div className="eliza-ob-mini-screen">
          <div className="eliza-ob-mini-row">
            OpenAI <span>Connect</span>
          </div>
          <div className="eliza-ob-mini-row">
            Anthropic <span>Connect</span>
          </div>
          <div className="eliza-ob-mini-row">
            Google AI <span>Connect</span>
          </div>
        </div>
        <p>
          If you already pay for other AI tools, add them here and I can route
          work through them.
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
