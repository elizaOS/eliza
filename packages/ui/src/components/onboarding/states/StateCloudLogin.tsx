export type CloudOAuthProvider = "google" | "discord" | "x" | "email";

export interface StateCloudLoginProps {
  onConnect: (provider: CloudOAuthProvider) => void;
  onBack: () => void;
}

const PROVIDERS: ReadonlyArray<{
  id: CloudOAuthProvider;
  label: string;
  mark: string;
}> = [
  { id: "google", label: "Continue with Google", mark: "G" },
  { id: "discord", label: "Continue with Discord", mark: "D" },
  { id: "x", label: "Continue with X", mark: "X" },
  { id: "email", label: "Continue with Email", mark: "@" },
];

export function StateCloudLogin(props: StateCloudLoginProps): React.JSX.Element {
  const { onConnect, onBack } = props;
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="cloud-login"
    >
      <h1>Eliza Cloud</h1>
      <p>
        Sign in to start your agent. After this, Eliza can take over onboarding
        inside chat.
      </p>
      <div className="eliza-ob-oauth-grid">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className="eliza-ob-btn eliza-ob-oauth-button"
            onClick={() => onConnect(provider.id)}
          >
            <span className="eliza-ob-oauth-mark">{provider.mark}</span>
            {provider.label}
          </button>
        ))}
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn secondary"
          onClick={onBack}
        >
          Back
        </button>
      </div>
    </section>
  );
}
