/**
 * Loading screen — NieR: Automata inspired loader with horizontal progress bar,
 * phase label, and percentage indicator.
 */

import { useEffect, useState } from "react";
import type { StartupPhase } from "../state";

const PHASE_META: Record<StartupPhase, { label: string; progress: number }> = {
  "starting-backend": { label: "Initializing systems", progress: 20 },
  "initializing-agent": { label: "Loading neural network", progress: 50 },
  ready: { label: "Systems online", progress: 100 },
};

interface LoadingScreenProps {
  phase?: StartupPhase;
  elapsedSeconds?: number;
  vrmUrl?: string;
}

export function LoadingScreen({
  phase = "starting-backend",
  elapsedSeconds,
  vrmUrl,
}: LoadingScreenProps) {
  const [vrmCached, setVrmCached] = useState(false);
  const [fetchProgress, setFetchProgress] = useState(0);
  const [, setRuntimeElapsedSeconds] = useState(0);

  useEffect(() => {
    if (typeof elapsedSeconds === "number") return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setRuntimeElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [elapsedSeconds]);

  useEffect(() => {
    if (!vrmUrl) return;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(vrmUrl, { signal: controller.signal });
        const contentLength = Number(
          response.headers.get("content-length") || 0,
        );

        if (!contentLength || !response.body) {
          setVrmCached(true);
          return;
        }

        const reader = response.body.getReader();
        let received = 0;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          setFetchProgress(Math.min(received / contentLength, 1));
        }

        setVrmCached(true);
      } catch {
        // Non-blocking — VRM will load normally later.
      }
    })();

    return () => controller.abort();
  }, [vrmUrl]);

  const meta = PHASE_META[phase];
  let progress: number;
  if (vrmCached) {
    progress = Math.max(meta.progress, 80);
  } else if (fetchProgress > 0) {
    progress = Math.max(meta.progress, Math.round(55 + fetchProgress * 25));
  } else {
    progress = meta.progress;
  }
  const label = vrmCached && phase !== "ready" ? "Loading avatar" : meta.label;

  return (
    <div className="loading-screen">
      <div className="loading-screen__center">
        <div className="loading-screen__title">
          LOADING
          <span className="loading-screen__dots" />
        </div>

        <div className="loading-screen__bar-row">
          <div className="loading-screen__progress-track">
            <div
              className="loading-screen__progress-fill"
              style={{
                width: `${progress}%`,
                transition: "width 1.5s ease-out",
              }}
            />
          </div>
          <div className="loading-screen__percent">{progress} %</div>
        </div>

        <div className="loading-screen__phase">{label}</div>
      </div>
    </div>
  );
}
