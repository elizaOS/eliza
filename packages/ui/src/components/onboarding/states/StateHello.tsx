import { AvatarHost } from "../../../avatar-runtime";

export interface StateHelloProps {
  transcript?: string;
  onBegin: () => void;
}

export function StateHello(props: StateHelloProps): React.JSX.Element {
  const { transcript, onBegin } = props;
  return (
    <section className="eliza-ob-screen centered" data-eliza-ob-state="hello">
      <div className="eliza-ob-hello">
        <div
          className="eliza-ob-agent-canvas"
          style={{ width: "min(270px, 78vw)", height: 112 }}
        >
          <AvatarHost />
        </div>
        <div className="eliza-ob-hello-word">Hello</div>
        <div className="eliza-ob-transcript">{transcript ?? ""}</div>
        <button type="button" className="eliza-ob-btn orange" onClick={onBegin}>
          Tap to begin
        </button>
        <div className="eliza-ob-tap-hint">
          voice and transcript start after your tap
        </div>
      </div>
    </section>
  );
}
