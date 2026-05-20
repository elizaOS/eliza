import { OnboardingAvatar } from "./OnboardingAvatar";

export interface StateHelloProps {
  transcript?: string;
  onBegin: () => void;
}

export function StateHello(props: StateHelloProps): React.JSX.Element {
  const { transcript, onBegin } = props;
  return (
    <main className="eliza-ob-screen centered" data-eliza-ob-state="hello">
      <div className="eliza-ob-hello">
        <OnboardingAvatar />
        <h1 className="eliza-ob-hello-word">Hello</h1>
        <div
          className="eliza-ob-transcript"
          aria-live="polite"
          aria-atomic="true"
        >
          {transcript ?? ""}
        </div>
        <button type="button" className="eliza-ob-btn orange" onClick={onBegin}>
          Begin
        </button>
      </div>
    </main>
  );
}
