/**
 * TranscriptsView — the Transcripts surface (#8789): a recordings list on the
 * left, the word-synced {@link TranscriptPlayer} on the right. Minimal + light,
 * as few controls as possible. Presentational (prop-driven) so it unit-tests
 * without the data layer; a thin container wires `client.listTranscripts` /
 * `client.getTranscript`.
 *
 * Meetings (#11856): the header carries the {@link MeetingJoinBar} (paste a
 * meeting URL → the bot joins), list rows for `source: "meeting"` records show
 * a platform badge + participant count + a LIVE dot while recording, and the
 * detail pane renders the {@link LiveMeetingPane} for an in-progress meeting.
 */

import {
  MEETING_PLATFORM_LABELS,
  type MeetingJoinRequest,
  type MeetingPlatform,
  type MeetingSession,
} from "@elizaos/shared";
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
import { LiveMeetingPane } from "./LiveMeetingPane";
import { MeetingJoinBar } from "./MeetingJoinBar";
import { meetingTranscriptMeta } from "./meeting-live";
import { TranscriptPlayer } from "./TranscriptPlayer";

/**
 * List-row projection. `source` + the server-computed `meeting` fields are
 * already part of {@link TranscriptSummary}; this alias documents the intent at
 * the view boundary without widening the contract.
 */
export type MeetingAwareTranscriptSummary = TranscriptSummary;

/** Look up the label for a summary's platform, only if it's a known platform. */
function platformLabel(platform: string | undefined): string | null {
  if (!platform) return null;
  return platform in MEETING_PLATFORM_LABELS
    ? MEETING_PLATFORM_LABELS[platform as MeetingPlatform]
    : null;
}

export interface TranscriptsViewProps {
  transcripts: MeetingAwareTranscriptSummary[];
  selectedId: string | null;
  selected: Transcript | null;
  onSelect(id: string): void;
  loading?: boolean;
  error?: string | null;
  /** Sessions not yet ended/failed (GET /api/meetings?active=1). */
  activeMeetings?: MeetingSession[];
  onJoinMeeting?(input: MeetingJoinRequest): void;
  onStopMeeting?(sessionId: string): void;
  joiningMeeting?: boolean;
  meetingError?: string | null;
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

/** Small accent dot + label shown on live meeting rows/headers. */
function LiveIndicator({ testId }: { testId: string }): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1 text-xs font-medium text-accent"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
      LIVE
    </span>
  );
}

function TranscriptRow({
  summary,
  active,
  onSelect,
}: {
  summary: MeetingAwareTranscriptSummary;
  active: boolean;
  onSelect(id: string): void;
}): React.JSX.Element {
  const isMeeting = summary.source === "meeting";
  const isLive = isMeeting && summary.status === "recording";
  // The server projects the meeting badge + participant count onto the summary
  // (summarizeTranscript); the row only displays them — it never counts a
  // roster array here.
  const meeting = isMeeting ? summary.meeting : undefined;
  const meetingPlatformLabel = platformLabel(meeting?.platform);
  const participantCount = meeting?.participantCount ?? 0;
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
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium">{summary.title}</span>
        {isLive ? (
          <LiveIndicator testId={`transcript-live-${summary.id}`} />
        ) : null}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted [&>span]:shrink-0">
        {meetingPlatformLabel ? (
          <>
            <span
              className="truncate"
              data-testid={`transcript-platform-${summary.id}`}
            >
              {meetingPlatformLabel}
            </span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span>{formatDate(summary.createdAt)}</span>
        <span aria-hidden>·</span>
        <span>{formatDuration(summary.durationMs)}</span>
        {isMeeting && participantCount > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span data-testid={`transcript-participants-${summary.id}`}>
              {participantCount}{" "}
              {participantCount === 1 ? "participant" : "participants"}
            </span>
          </>
        ) : !isMeeting && summary.speakerCount > 1 ? (
          <>
            <span aria-hidden>·</span>
            <span>{summary.speakerCount} speakers</span>
          </>
        ) : null}
        {status && !isLive ? (
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

/** Detail-pane header for a meeting record: platform badge + roster. */
function MeetingDetailHeader({
  transcript,
}: {
  transcript: Transcript;
}): React.JSX.Element | null {
  const meta = meetingTranscriptMeta(transcript);
  if (!meta.platform && meta.participants.length === 0) return null;
  return (
    <div
      data-testid="meeting-detail-meta"
      className="flex flex-wrap items-center gap-2 text-xs text-muted"
    >
      {meta.platform ? (
        <span
          data-testid="meeting-detail-platform"
          className="rounded-sm border border-border px-1.5 py-0.5 font-medium text-txt"
        >
          {MEETING_PLATFORM_LABELS[meta.platform]}
        </span>
      ) : null}
      {meta.participants.length > 0 ? (
        <span data-testid="meeting-detail-participants" className="truncate">
          {meta.participants.map((p) => p.displayName).join(", ")}
        </span>
      ) : null}
    </div>
  );
}

export function TranscriptsView({
  transcripts,
  selectedId,
  selected,
  onSelect,
  loading,
  error,
  activeMeetings = [],
  onJoinMeeting,
  onStopMeeting,
  joiningMeeting,
  meetingError,
}: TranscriptsViewProps): React.JSX.Element {
  const joinBar =
    onJoinMeeting && onStopMeeting ? (
      <MeetingJoinBar
        activeMeetings={activeMeetings}
        onJoin={onJoinMeeting}
        onStop={onStopMeeting}
        joining={joiningMeeting}
        error={meetingError}
      />
    ) : null;

  if (!error && !loading && transcripts.length === 0) {
    return (
      <ShellViewAgentSurface viewId="transcripts">
        <div
          data-testid="transcripts-view"
          className="flex h-full min-h-0 w-full flex-col gap-4"
        >
          {joinBar}
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

  const selectedIsLiveMeeting =
    selected?.source === "meeting" && selected.status === "recording";

  return (
    <ShellViewAgentSurface viewId="transcripts">
      <div
        data-testid="transcripts-view"
        className="flex h-full min-h-0 w-full flex-col gap-4"
      >
        {joinBar}
        <div className="flex min-h-0 w-full flex-1 flex-col gap-4 md:flex-row">
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

          <section
            className={cn(
              "min-h-0 min-w-0 flex-1",
              selectedIsLiveMeeting ? "flex flex-col" : "overflow-y-auto",
            )}
          >
            {selected ? (
              <div
                className={cn(
                  "flex flex-col gap-3",
                  selectedIsLiveMeeting && "min-h-0 flex-1",
                )}
              >
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-txt">
                    {selected.title}
                  </h2>
                  {selectedIsLiveMeeting ? (
                    <LiveIndicator testId="meeting-detail-live" />
                  ) : null}
                </div>
                {selected.source === "meeting" ? (
                  <MeetingDetailHeader transcript={selected} />
                ) : null}
                {selectedIsLiveMeeting ? (
                  <LiveMeetingPane transcript={selected} />
                ) : (
                  <TranscriptPlayer
                    transcript={selected}
                    audioUrl={selected.audioUrl}
                  />
                )}
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
      </div>
    </ShellViewAgentSurface>
  );
}
