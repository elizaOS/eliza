import { AvatarHost } from "../../../avatar-runtime";

export interface StateCloudChatProps {
  transcript?: string;
  onEnterChat: () => void;
}

export function StateCloudChat(props: StateCloudChatProps): JSX.Element {
  const { transcript, onEnterChat } = props;
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="cloud-chat"
    >
      <div className="eliza-ob-agent">
        <div
          className="eliza-ob-agent-canvas"
          style={{ width: "min(270px, 78vw)", height: 112 }}
        >
          <AvatarHost />
        </div>
        <div className="eliza-ob-transcript">
          {transcript ?? "You're connected. I'll show you around from chat."}
        </div>
      </div>
      <div className="eliza-ob-tutorial-card">
        <strong>Cloud handoff</strong>
        <p>
          Eliza Cloud users jump straight into chat; the agent carries
          onboarding as a conversation.
        </p>
        <div className="eliza-ob-mini-screen">
          <div className="eliza-ob-mini-row">
            Chat agent <span className="eliza-ob-mini-pill">online</span>
          </div>
          <div className="eliza-ob-mini-row">
            Onboarding tour <span>agent-led</span>
          </div>
        </div>
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={onEnterChat}
        >
          Enter chat
        </button>
      </div>
    </section>
  );
}
