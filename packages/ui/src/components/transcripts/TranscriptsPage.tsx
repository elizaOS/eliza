/**
 * TranscriptsPage (#8789) — the data container for the Transcripts view: loads
 * the recordings list + the selected record via the client and feeds the
 * presentational {@link TranscriptsView}. Registered as the `transcripts`
 * built-in shell view.
 *
 * Meetings (#11856): also owns the meeting-bot lifecycle — active-session
 * list (`GET /api/meetings?active=1`), join (`POST /api/meetings`), stop
 * (`DELETE /api/meetings/:id`) — and refreshes both lists on `meeting-status`
 * events from the agent WebSocket so a requested bot's live row appears
 * without a reload.
 */

import type {
  MeetingJoinRequest,
  MeetingSession,
  MeetingSessionStatus,
} from "@elizaos/shared";
import type { Transcript } from "@elizaos/shared/transcripts";
import * as React from "react";
import { client } from "../../api/client";
import { parseMeetingStatusEvent } from "../../api/client-meetings";
import { ViewHeader } from "../shared/ViewHeader";
import type { MeetingAwareTranscriptSummary } from "./TranscriptsView";
import { TranscriptsView } from "./TranscriptsView";

/** Session states after which the transcript is finalized (no longer live). */
const TERMINAL_MEETING_STATUSES: ReadonlySet<MeetingSessionStatus> = new Set([
  "ended",
  "failed",
]);

export function TranscriptsPage(): React.JSX.Element {
  const [transcripts, setTranscripts] = React.useState<
    MeetingAwareTranscriptSummary[]
  >([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Transcript | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [activeMeetings, setActiveMeetings] = React.useState<MeetingSession[]>(
    [],
  );
  const [joiningMeeting, setJoiningMeeting] = React.useState(false);
  const [meetingError, setMeetingError] = React.useState<string | null>(null);

  // The live-selected id, mirrored into a ref so the WebSocket subscription
  // (which must not re-bind on every selection change) can read it.
  const selectedIdRef = React.useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const loadTranscript = React.useCallback((id: string) => {
    return client
      .getTranscript(id)
      .then((r) => setSelected(r.transcript))
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load transcript"),
      );
  }, []);

  const refresh = React.useCallback(async () => {
    const [listResult, meetingsResult] = await Promise.allSettled([
      client.listTranscripts(),
      client.listMeetings({ active: true }),
    ]);
    if (listResult.status === "fulfilled") {
      setTranscripts(listResult.value.transcripts);
    }
    if (meetingsResult.status === "fulfilled") {
      setActiveMeetings(meetingsResult.value.sessions);
      // Recovered: clear a prior meetings-fetch failure banner.
      setMeetingError(null);
    } else {
      // The active-meetings fetch failed. Swallowing it silently would render
      // the join bar as a healthy "no active meetings" state even while a bot
      // is live in a broken/unreachable backend (#12784: transport/5xx failure
      // must not collapse into a designed-empty state). Surface it in the join
      // bar's error slot; keep the last-known active sessions on screen rather
      // than blanking them, so a transient poll error can't make a live meeting
      // vanish. A successful refresh (above) clears this.
      setMeetingError(
        meetingsResult.reason instanceof Error
          ? meetingsResult.reason.message
          : "Failed to load active meetings",
      );
    }
    if (listResult.status === "rejected") {
      throw listResult.reason;
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    refresh()
      .catch((e) => {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Failed to load transcripts",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Session lifecycle over the agent WebSocket: keep the active strip fresh
  // and re-list transcripts when a live meeting record appears/finalizes.
  // When the finalized session is the transcript currently OPEN in the detail
  // pane, also refetch that record so it flips out of "recording" — the list
  // refresh alone leaves the open pane polling forever (LiveMeetingPane).
  React.useEffect(() => {
    return client.onWsEvent("meeting-status", (data) => {
      const event = parseMeetingStatusEvent(data);
      if (!event) return;
      const { session } = event;
      if (
        TERMINAL_MEETING_STATUSES.has(session.status) &&
        session.transcriptId &&
        session.transcriptId === selectedIdRef.current
      ) {
        loadTranscript(session.transcriptId).catch(() => {
          // Transient — a re-select or the next event re-loads.
        });
      }
      refresh().catch(() => {
        // Transient — the next status event or view entry re-lists.
      });
    });
  }, [refresh, loadTranscript]);

  const onSelect = React.useCallback(
    (id: string) => {
      setSelectedId(id);
      setSelected(null);
      void loadTranscript(id);
    },
    [loadTranscript],
  );

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

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ViewHeader title="Transcripts" />
      <div className="min-h-0 flex-1 overflow-hidden">
        <TranscriptsView
          transcripts={transcripts}
          selectedId={selectedId}
          selected={selected}
          onSelect={onSelect}
          loading={loading}
          error={error}
          activeMeetings={activeMeetings}
          onJoinMeeting={onJoinMeeting}
          onStopMeeting={onStopMeeting}
          joiningMeeting={joiningMeeting}
          meetingError={meetingError}
        />
      </div>
    </div>
  );
}
