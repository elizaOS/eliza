/**
 * MeetingJoinBar (#11856) — the "Join a meeting" affordance of the Transcripts
 * view: paste a Meet/Teams/Zoom URL (validated live with `parseMeetingUrl`,
 * platform label shown on recognize), optionally name the bot, submit to
 * `POST /api/meetings`. Below it, the active-sessions strip with a Stop
 * button per session. Presentational + prop-driven; the page container wires
 * `client.requestMeetingBot` / `client.stopMeeting`.
 */

import {
  MEETING_PLATFORM_LABELS,
  type MeetingJoinRequest,
  type MeetingSession,
  parseMeetingUrl,
} from "@elizaos/shared";
import { Video } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface MeetingJoinBarProps {
  activeMeetings: MeetingSession[];
  onJoin(input: MeetingJoinRequest): void;
  onStop(sessionId: string): void;
  /** True while a join request is in flight. */
  joining?: boolean;
  error?: string | null;
  className?: string;
}

const SESSION_STATUS_LABEL: Record<MeetingSession["status"], string> = {
  requested: "Requested",
  joining: "Joining",
  awaiting_admission: "Waiting to be admitted",
  active: "In meeting",
  leaving: "Leaving",
  ended: "Ended",
  failed: "Failed",
};

export function MeetingJoinBar({
  activeMeetings,
  onJoin,
  onStop,
  joining,
  error,
  className,
}: MeetingJoinBarProps): React.JSX.Element {
  const [url, setUrl] = React.useState("");
  const [botName, setBotName] = React.useState("");
  const parsed = React.useMemo(
    () => (url.trim() ? parseMeetingUrl(url) : null),
    [url],
  );
  const showInvalid = url.trim().length > 0 && parsed === null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed || joining) return;
    const name = botName.trim();
    onJoin({
      platform: parsed.platform,
      meetingUrl: parsed.meetingUrl,
      ...(name ? { botName: name } : {}),
    });
    setUrl("");
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <form
        data-testid="meeting-join-form"
        onSubmit={submit}
        className="flex flex-wrap items-center gap-2"
      >
        <div className="relative min-w-48 flex-1">
          <Input
            data-testid="meeting-url-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a Meet, Teams, or Zoom link"
            aria-label="Meeting URL"
            aria-invalid={showInvalid || undefined}
            className="pr-28"
          />
          {parsed ? (
            <span
              data-testid="meeting-platform-hint"
              className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 text-xs text-accent-fg"
            >
              <Video className="h-3.5 w-3.5" aria-hidden />
              {MEETING_PLATFORM_LABELS[parsed.platform]}
            </span>
          ) : null}
        </div>
        <Input
          data-testid="meeting-bot-name"
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
          placeholder="Bot name (optional)"
          aria-label="Bot name"
          className="w-40"
        />
        <Button
          type="submit"
          size="sm"
          data-testid="meeting-join-submit"
          disabled={!parsed || joining}
        >
          {joining ? "Joining…" : "Join meeting"}
        </Button>
      </form>
      {showInvalid ? (
        <p data-testid="meeting-url-invalid" className="text-xs text-muted">
          Not a recognizable Meet, Teams, or Zoom meeting link.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {activeMeetings.length > 0 ? (
        <div data-testid="active-meetings" className="flex flex-col gap-1">
          {activeMeetings.map((m) => (
            <div
              key={m.id}
              data-testid={`active-meeting-${m.id}`}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-txt"
            >
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  m.status === "active" ? "bg-accent" : "bg-muted",
                )}
              />
              <span className="truncate">
                {MEETING_PLATFORM_LABELS[m.platform]}
                {m.botName ? ` · ${m.botName}` : ""}
              </span>
              <span className="text-xs text-muted">
                {SESSION_STATUS_LABEL[m.status]}
              </span>
              <button
                type="button"
                data-testid={`stop-meeting-${m.id}`}
                onClick={() => onStop(m.id)}
                className="ml-auto rounded-sm px-2 py-0.5 text-xs text-muted transition-colors hover:bg-bg-muted/30 hover:text-txt"
              >
                Stop
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
