/**
 * LiveMeetingPage (#11856, #13594) — the chrome-minimal live-meeting affordance
 * that survives at `/apps/transcripts` after the recordings browser was folded
 * into the Knowledge hub (#13594). It is NOT a second recordings surface: there
 * is no history list, no per-record `TranscriptPlayer`, no recordings sidebar.
 *
 * It keeps exactly the LIVE half of the old Transcripts view — join a meeting
 * ({@link MeetingJoinBar}: paste a Meet/Teams/Zoom URL → the bot joins),
 * see/stop active sessions, and watch each in-progress transcript stream live
 * ({@link LiveMeetingPane}). Finalized recordings appear only in the Knowledge
 * hub's Transcripts facet. The meeting-bot lifecycle mirrors the old page:
 * active-session list, join/stop, and `meeting-status` WebSocket refreshes.
 */

import type {
  MeetingJoinRequest,
  MeetingSession,
  MeetingSessionStatus,
} from "@elizaos/shared";
import type { Transcript } from "@elizaos/shared/transcripts";
import { Radio } from "lucide-react";
import * as React from "react";
import { client } from "../../api/client";
import { parseMeetingStatusEvent } from "../../api/client-meetings";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { LiveMeetingPane } from "./LiveMeetingPane";
import { MeetingJoinBar } from "./MeetingJoinBar";

/** Session states after which a bot is no longer live in a meeting. */
const TERMINAL_MEETING_STATUSES: ReadonlySet<MeetingSessionStatus> = new Set([
  "ended",
  "failed",
]);

/** A session actively recording (its transcript is streaming live). */
function isRecordingSession(session: MeetingSession): boolean {
  return (
    !TERMINAL_MEETING_STATUSES.has(session.status) &&
    typeof session.transcriptId === "string" &&
    session.transcriptId.length > 0
  );
}

export function LiveMeetingPage(): React.JSX.Element {
  const [activeMeetings, setActiveMeetings] = React.useState<MeetingSession[]>(
    [],
  );
  const [liveTranscripts, setLiveTranscripts] = React.useState<
    Record<string, Transcript>
  >({});
  // Per-transcript load errors (codex P2): a broken GET /api/transcripts/:id
  // must read as an error, not an indefinite "Connecting…".
  const [transcriptErrors, setTranscriptErrors] = React.useState<
    Record<string, string>
  >({});
  const [joiningMeeting, setJoiningMeeting] = React.useState(false);
  const [meetingError, setMeetingError] = React.useState<string | null>(null);

  // Fetch a live transcript. `force` re-fetches even one we already hold (used
  // when a meeting finalizes so its pane flips out of "recording"); otherwise a
  // functional-state guard skips a record we have, keeping this stable.
  const loadLiveTranscript = React.useCallback(
    (transcriptId: string, force = false) => {
      return client
        .getTranscript(transcriptId)
        .then((r) => {
          setLiveTranscripts((prev) =>
            !force && prev[transcriptId]
              ? prev
              : { ...prev, [transcriptId]: r.transcript },
          );
          // Recovered: clear any prior load error for this record.
          setTranscriptErrors((prev) => {
            if (!prev[transcriptId]) return prev;
            const { [transcriptId]: _cleared, ...rest } = prev;
            return rest;
          });
        })
        .catch((e) => {
          // Distinguish a broken transcript load from a still-connecting
          // meeting so the pane doesn't hang on "Connecting…" forever.
          setTranscriptErrors((prev) => ({
            ...prev,
            [transcriptId]:
              e instanceof Error ? e.message : "Failed to load transcript",
          }));
        });
    },
    [],
  );

  // Only fetches + sets the active sessions, so it never closes over the
  // transcript cache and stays referentially stable across renders.
  const refresh = React.useCallback(async () => {
    try {
      const { sessions } = await client.listMeetings({ active: true });
      setActiveMeetings(sessions);
      setMeetingError(null);
    } catch (e) {
      // A transport/5xx failure must not collapse into a healthy "no active
      // meetings" state (#12784): surface it, keep the last-known sessions.
      setMeetingError(
        e instanceof Error ? e.message : "Failed to load active meetings",
      );
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull the live transcript for each recording session we don't yet hold,
  // whenever the active-session list changes.
  React.useEffect(() => {
    for (const session of activeMeetings) {
      if (isRecordingSession(session) && session.transcriptId) {
        void loadLiveTranscript(session.transcriptId);
      }
    }
  }, [activeMeetings, loadLiveTranscript]);

  // Session lifecycle over the agent WebSocket: keep the active strip fresh and
  // refetch a finalized transcript so its live pane flips out of "recording".
  React.useEffect(() => {
    return client.onWsEvent("meeting-status", (data) => {
      const event = parseMeetingStatusEvent(data);
      if (!event) return;
      const { session } = event;
      if (
        TERMINAL_MEETING_STATUSES.has(session.status) &&
        session.transcriptId
      ) {
        void loadLiveTranscript(session.transcriptId, true);
      }
      void refresh();
    });
  }, [refresh, loadLiveTranscript]);

  const onJoinMeeting = React.useCallback(
    (input: MeetingJoinRequest) => {
      setJoiningMeeting(true);
      setMeetingError(null);
      client
        .requestMeetingBot(input)
        .then(() => refresh())
        .catch((e) =>
          setMeetingError(
            e instanceof Error ? e.message : "Failed to join meeting",
          ),
        )
        .finally(() => setJoiningMeeting(false));
    },
    [refresh],
  );

  const onStopMeeting = React.useCallback(
    (sessionId: string) => {
      setMeetingError(null);
      client
        .stopMeeting(sessionId)
        .then(() => refresh())
        .catch((e) =>
          setMeetingError(
            e instanceof Error ? e.message : "Failed to stop meeting",
          ),
        );
    },
    [refresh],
  );

  const recordingSessions = activeMeetings.filter(isRecordingSession);

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ShellViewAgentSurface viewId="transcripts">
        <div
          data-testid="live-meeting-page"
          className="flex h-full min-h-0 w-full flex-col gap-4"
        >
          <MeetingJoinBar
            activeMeetings={activeMeetings}
            onJoin={onJoinMeeting}
            onStop={onStopMeeting}
            joining={joiningMeeting}
            error={meetingError}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {recordingSessions.length === 0 ? (
              <div
                data-testid="live-meeting-empty"
                className="grid h-full place-items-center px-6 text-center"
              >
                <div className="flex max-w-sm flex-col items-center gap-3 text-muted">
                  <Radio className="size-6" aria-hidden />
                  <p className="text-sm">
                    No live meeting. Paste a meeting link above to have the
                    agent join and transcribe. Past recordings live in
                    Knowledge.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {recordingSessions.map((session) => {
                  const transcript = session.transcriptId
                    ? liveTranscripts[session.transcriptId]
                    : undefined;
                  const transcriptError = session.transcriptId
                    ? transcriptErrors[session.transcriptId]
                    : undefined;
                  return (
                    <section
                      key={session.id}
                      data-testid={`live-meeting-${session.id}`}
                      className="flex min-h-0 flex-col gap-2"
                    >
                      <h2 className="text-sm font-semibold text-txt">
                        {transcript?.title ?? session.botName}
                      </h2>
                      {transcript ? (
                        <LiveMeetingPane transcript={transcript} />
                      ) : transcriptError ? (
                        <p
                          data-testid={`live-meeting-error-${session.id}`}
                          className="text-sm text-muted"
                          role="alert"
                        >
                          {transcriptError}
                        </p>
                      ) : (
                        <p className="text-sm text-muted">
                          Connecting to the meeting transcript…
                        </p>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </ShellViewAgentSurface>
    </div>
  );
}
