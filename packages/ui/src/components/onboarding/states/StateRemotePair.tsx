import { useState } from "react";

export interface StateRemotePairProps {
  onPair: (url: string, code: string) => void;
  onBack: () => void;
}

export function StateRemotePair(props: StateRemotePairProps): JSX.Element {
  const { onPair, onBack } = props;
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="remote-pair"
    >
      <h1>Remote Agent</h1>
      <div className="eliza-ob-form">
        <input
          className="eliza-ob-input"
          placeholder="Agent URL"
          autoComplete="off"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          className="eliza-ob-input"
          placeholder="Pairing code"
          autoComplete="off"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      <div className="eliza-ob-footer">
        <button
          type="button"
          className="eliza-ob-btn secondary"
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="eliza-ob-btn orange"
          onClick={() => onPair(url, code)}
        >
          Pair
        </button>
      </div>
    </section>
  );
}
