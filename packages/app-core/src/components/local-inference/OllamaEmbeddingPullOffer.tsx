import { Button } from "@elizaos/ui";
import {
  type OllamaPullProgressSnapshot,
  SUGGESTED_OLLAMA_EMBEDDING_MODEL,
} from "../../services/local-inference/ollama-pull-model";
import { InferenceHelpHint } from "./InferenceHelpHint";

type Props = {
  displayName: string;
  endpoint: string;
  onPull: () => void | Promise<void>;
  busy: boolean;
  /** Streamed pull progress; cleared when not busy. */
  progress: OllamaPullProgressSnapshot | null;
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * When Ollama is selected but no embedding-shaped models appear in the probe
 * list, offer a one-click pull of a small default embedding model (same idea
 * as {@link EmbeddingGgufOffer} for Milady GGUF).
 */
export function OllamaEmbeddingPullOffer({
  displayName,
  endpoint,
  onPull,
  busy,
  progress,
}: Props) {
  return (
    <div className="rounded-xl border border-primary/40 bg-primary/10 p-4 flex flex-wrap items-start gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-primary/90">
          Add an Ollama embedding model
          <InferenceHelpHint aria-label="Suggested Ollama embedding model">
            <p>
              Pulls{" "}
              <span className="font-mono text-[11px]">
                {SUGGESTED_OLLAMA_EMBEDDING_MODEL}
              </span>{" "}
              into Ollama on this machine so{" "}
              <span className="font-mono text-[11px]">
                OPENAI_EMBEDDING_MODEL
              </span>{" "}
              can match a local embedding id. Large pulls can take a few
              minutes.
            </p>
          </InferenceHelpHint>
        </div>
        <div className="text-sm font-medium">
          <span className="font-mono">{SUGGESTED_OLLAMA_EMBEDDING_MODEL}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          Via {displayName} at{" "}
          <span className="font-mono text-[11px] break-all">{endpoint}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          After the pull finishes, refresh Local AI status (↻) so the model list
          updates, then save it to agent config if needed.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        className="shrink-0"
        onClick={() => void onPull()}
        disabled={busy}
      >
        {busy ? "Pulling…" : `Pull ${SUGGESTED_OLLAMA_EMBEDDING_MODEL}`}
      </Button>

      {busy ? (
        <div className="w-full basis-full space-y-2 pt-1">
          <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 break-words leading-snug">
              {progress?.status?.trim() || "Starting…"}
            </span>
            {progress?.percent != null ? (
              <span className="shrink-0 tabular-nums">{progress.percent}%</span>
            ) : null}
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              progress?.percent != null ? progress.percent : undefined
            }
            aria-label="Ollama model download progress"
          >
            {progress?.percent != null ? (
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${progress.percent}%` }}
              />
            ) : (
              <div className="h-full w-[36%] rounded-full bg-primary/70 motion-safe:animate-pulse" />
            )}
          </div>
          {progress?.completed != null &&
          progress?.total != null &&
          progress.total > 0 ? (
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {formatBytes(progress.completed)} / {formatBytes(progress.total)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
