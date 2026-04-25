/**
 * Loading screen — NieR: Automata inspired loader with horizontal progress bar,
 * phase label, and percentage indicator.
 */

import { useEffect, useState } from "react";
import type { StartupPhase } from "../../state";
import { useApp } from "../../state";

const PHASE_META: Record<
  StartupPhase,
  { labelKey: string; defaultLabel: string; progress: number }
> = {
  "starting-backend": {
    labelKey: "loadingscreen.InitializingSystems",
    defaultLabel: "Initializing systems",
    progress: 20,
  },
  "initializing-agent": {
    labelKey: "loadingscreen.LoadingNeuralNetwork",
    defaultLabel: "Loading neural network",
    progress: 50,
  },
  ready: {
    labelKey: "loadingscreen.SystemsOnline",
    defaultLabel: "Systems online",
    progress: 100,
  },
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
  const { t } = useApp();
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
  const label =
    vrmCached && phase !== "ready"
      ? t("loadingscreen.LoadingAvatar", { defaultValue: "Loading avatar" })
      : t(meta.labelKey, { defaultValue: meta.defaultLabel });

  return (
    <div className="flex items-center justify-center h-dvh bg-bg relative overflow-hidden">
      <div className="flex flex-col items-start gap-3.5 w-[420px] max-w-[90vw]">
        <div className="font-mono text-sm font-normal tracking-[0.35em] uppercase text-txt/70 select-none">
          {t("common.loading", { defaultValue: "Loading" })}
          <span className="loading-screen__dots" />
        </div>

        <div className="flex items-center gap-4 w-full">
          <div className="flex-1 h-1 bg-bg-accent overflow-hidden relative">
            <div
              className="h-full bg-accent relative shadow-[0_0_8px_var(--accent-subtle)]"
              style={{
                width: `${progress}%`,
                transition: "width 1.5s ease-out",
              }}
            />
          </div>
          <div className="font-mono text-sm font-normal tracking-[0.15em] text-white/60 min-w-[48px] text-right select-none">
            {progress} %
          </div>
        </div>

        <div className="font-mono text-xs-tight font-normal tracking-[0.12em] uppercase text-white/35 select-none">
          {label}
        </div>
      </div>
    </div>
  );
}
