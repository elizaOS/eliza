import { useState } from "react";
import { AvatarHost } from "../../../avatar-runtime";

export interface StateProfileNameProps {
  transcript?: string;
  initialName?: string;
  onContinue: (name: string) => void;
}

export function StateProfileName(props: StateProfileNameProps): JSX.Element {
  const { transcript, initialName, onContinue } = props;
  const [name, setName] = useState(initialName ?? "");
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="profile-name"
    >
      <div className="eliza-ob-agent">
        <div
          className="eliza-ob-agent-canvas"
          style={{ width: "min(270px, 78vw)", height: 112 }}
        >
          <AvatarHost />
        </div>
        <div className="eliza-ob-transcript">
          {transcript ?? "Okay, can I get your name?"}
        </div>
      </div>
      <div className="eliza-ob-form">
        <input
          className="eliza-ob-input"
          placeholder="Your name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={() => onContinue(name)}
        >
          Continue
        </button>
      </div>
    </section>
  );
}
