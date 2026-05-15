import { useEffect, useRef, useState } from "react";
import { AvatarHost } from "../../../avatar-runtime";

export interface LocalDownloadProgress {
  ratio: number;
  meta: string;
  ready: boolean;
}

export interface StateLocalDownloadProps {
  transcript?: string;
  progress?: LocalDownloadProgress;
  onUseCloudInstead: () => void;
  onContinue: () => void;
  onReady?: () => void;
}

const MOCK_DURATION_MS = 6000;
const MOCK_STEP_MS = 200;

function useMockProgress(
  enabled: boolean,
  onReady?: () => void,
): LocalDownloadProgress {
  const [ratio, setRatio] = useState(0.06);
  const [meta, setMeta] = useState("Preparing model registry...");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const start = Date.now();
    const id = window.setInterval(() => {
      const elapsed = Date.now() - start;
      const next = Math.min(1, elapsed / MOCK_DURATION_MS);
      setRatio(next);
      if (next < 0.4) setMeta("Fetching tokenizer and embeddings...");
      else if (next < 0.85) setMeta("Downloading Eliza-1 weights...");
      else if (next < 1) setMeta("Verifying checksum...");
      else {
        setMeta("Ready");
        setReady(true);
        window.clearInterval(id);
        onReady?.();
      }
    }, MOCK_STEP_MS);
    return () => window.clearInterval(id);
  }, [enabled, onReady]);

  return { ratio, meta, ready };
}

export function StateLocalDownload(
  props: StateLocalDownloadProps,
): React.JSX.Element {
  const {
    transcript,
    progress: external,
    onUseCloudInstead,
    onContinue,
    onReady,
  } = props;
  const useMock = !external;
  const mock = useMockProgress(useMock, onReady);
  const progress = external ?? mock;
  const percent = Math.round(progress.ratio * 100);
  const notifiedExternalReady = useRef(false);

  useEffect(() => {
    if (external?.ready && !notifiedExternalReady.current) {
      notifiedExternalReady.current = true;
      onReady?.();
    }
  }, [external?.ready, onReady]);

  return (
    <section
      className="eliza-ob-screen centered"
      data-eliza-ob-state="local-download"
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
            "I need to download some models so we can chat beyond this point, I'll let you know when I'm ready."}
        </div>
      </div>
      <div className="eliza-ob-download-card">
        <strong>Downloading Eliza local models</strong>
        <div className="eliza-ob-progress-track">
          <div
            className="eliza-ob-progress-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="eliza-ob-download-meta">{progress.meta}</div>
        <div className="eliza-ob-footer">
          <button
            type="button"
            className="eliza-ob-btn secondary"
            onClick={onUseCloudInstead}
          >
            Use cloud instead
          </button>
          <button
            type="button"
            className="eliza-ob-btn orange"
            onClick={onContinue}
            disabled={!progress.ready}
          >
            Continue
          </button>
        </div>
      </div>
    </section>
  );
}
