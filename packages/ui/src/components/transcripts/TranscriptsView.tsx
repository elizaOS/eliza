/**
 * TranscriptsView — the Transcripts surface (#8789): a recordings list on the
 * left, the word-synced {@link TranscriptPlayer} on the right. Minimal + light,
 * as few controls as possible. Presentational (prop-driven) so it unit-tests
 * without the data layer; a thin container wires `client.listTranscripts` /
 * `client.getTranscript`.
 */

import type {
  Transcript,
  TranscriptStatus,
  TranscriptSummary,
} from "@elizaos/shared/transcripts";
import { AudioLines } from "lucide-react";
import type * as React from "react";
import { useAgentElement } from "../../agent-surface";
import { cn } from "../../lib/utils";
import { ChatEmptyStateWithRecommendations } from "../composites/chat";
import { Button } from "../ui/button";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { TranscriptPlayer } from "./TranscriptPlayer";

export interface TranscriptsViewProps {
  transcripts: TranscriptSummary[];
  selectedId: string | null;
  selected: Transcript | null;
  onSelect(id: string): void;
  loading?: boolean;
  error?: string | null;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function agentSafeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

const STATUS_LABEL: Record<TranscriptStatus, string> = {
  recording: "Recording",
  processing: "Processing",
  ready: "",
  failed: "Failed",
};

function TranscriptRow({
  summary,
  active,
  onSelect,
}: {
  summary: TranscriptSummary;
  active: boolean;
  onSelect(id: string): void;
}): React.JSX.Element {
  const status = STATUS_LABEL[summary.status];
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `transcript-${agentSafeId(summary.id)}`,
    role: "button",
    label: `Open transcript ${summary.title}`,
    group: "transcripts-list",
    status: active ? "active" : summary.status,
    description: "Select this recording in the Transcripts view",
    onActivate: () => onSelect(summary.id),
  });

  return (
    <Button
      ref={ref}
      {...agentProps}
      variant="ghost"
      data-testid={`transcript-row-${summary.id}`}
      data-active={active ? "true" : undefined}
      onClick={() => onSelect(summary.id)}
      className={cn(
        "h-auto w-full justify-start rounded-sm px-3 py-2 text-left font-normal text-txt transition-colors",
        active ? "bg-bg-muted/30" : "hover:bg-bg-muted/20",
      )}
    >
      <div className="truncate font-medium">{summary.title}</div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
        <span>{formatDate(summary.createdAt)}</span>
        <span aria-hidden>·</span>
        <span>{formatDuration(summary.durationMs)}</span>
        {summary.speakerCount > 1 ? (
          <>
            <span aria-hidden>·</span>
            <span>{summary.speakerCount} speakers</span>
          </>
        ) : null}
        {status ? (
          <>
            <span aria-hidden>·</span>
            <span>{status}</span>
          </>
        ) : null}
      </div>
      {summary.preview ? (
        <div className="mt-1 truncate text-xs text-muted">
          {summary.preview}
        </div>
      ) : null}
    </Button>
  );
}

export function TranscriptsView({
  transcripts,
  selectedId,
  selected,
  onSelect,
  loading,
  error,
}: TranscriptsViewProps): React.JSX.Element {
  if (!error && !loading && transcripts.length === 0) {
    return (
      <ShellViewAgentSurface viewId="transcripts">
        <div
          data-testid="transcripts-view"
          className="flex h-full min-h-0 w-full"
        >
          <div data-testid="transcripts-empty" className="flex flex-1">
            <ChatEmptyStateWithRecommendations
              icon={AudioLines}
              title="No transcripts yet."
              recommendations={[
                "Record and transcribe my next meeting",
                "Start a voice transcription now",
                "Summarize my most recent recording",
              ]}
            />
          </div>
        </div>
      </ShellViewAgentSurface>
    );
  }

  return (
    <ShellViewAgentSurface viewId="transcripts">
      <div
        data-testid="transcripts-view"
        className="flex h-full min-h-0 w-full flex-col gap-4 md:flex-row"
      >
        <aside className="flex w-full shrink-0 flex-col gap-1.5 md:w-72">
          {error ? (
            <p className="px-3 text-sm text-muted" role="alert">
              {error}
            </p>
          ) : loading && transcripts.length === 0 ? (
            <p className="px-3 text-sm text-muted">Loading…</p>
          ) : (
            <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
              {transcripts.map((t) => (
                <TranscriptRow
                  key={t.id}
                  summary={t}
                  active={t.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          )}
        </aside>

        <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-base font-semibold text-txt">
                {selected.title}
              </h2>
              <TranscriptPlayer
                transcript={selected}
                audioUrl={selected.audioUrl}
              />
            </div>
          ) : (
            <div
              data-testid="transcripts-detail-empty"
              className="grid h-full place-items-center text-sm text-muted/70"
            >
              Select a recording.
            </div>
          )}
        </section>
      </div>
    </ShellViewAgentSurface>
  );
}
