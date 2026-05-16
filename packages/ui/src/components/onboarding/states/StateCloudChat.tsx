import { AvatarHost } from "../../../avatar-runtime";

export interface CloudProvisioningProgress {
  status: "chat" | "provisioning" | "running" | "error";
  meta: string;
  ready: boolean;
}

export interface StateCloudChatProps {
  transcript?: string;
  progress?: CloudProvisioningProgress;
  onEnterChat: () => void;
}

export function StateCloudChat(props: StateCloudChatProps): React.JSX.Element {
  const { transcript, progress, onEnterChat } = props;
  const status = progress?.status ?? "provisioning";
  const statusLabel =
    status === "running"
      ? "real agent ready"
      : status === "error"
        ? "needs attention"
        : "provisioning";
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
          {transcript ??
            "I'm online now. I'll ask a few questions and show you around while your real server provisions."}
        </div>
      </div>
      <div className="eliza-ob-tutorial-card">
        <strong>Cloud onboarding chat</strong>
        <p>
          The instant cloud agent can chat, collect your preferences, and call
          safe onboarding actions. When the Hetzner server is ready, the same
          conversation is pushed into it.
        </p>
        <div className="eliza-ob-mini-screen">
          <div className="eliza-ob-mini-row">
            Chat agent <span className="eliza-ob-mini-pill">online</span>
          </div>
          <div className="eliza-ob-mini-row">
            Hetzner server <span>{statusLabel}</span>
          </div>
          <div className="eliza-ob-mini-row">
            Conversation <span>{progress?.ready ? "pushed" : "staged"}</span>
          </div>
        </div>
        {progress?.meta ? (
          <p className="eliza-ob-download-meta">{progress.meta}</p>
        ) : null}
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
