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

import type { MeetingJoinRequest, MeetingSession } from "@elizaos/shared";
import type { Transcript } from "@elizaos/shared/transcripts";
import * as React from "react";
import { client } from "../../api/client";
import { parseMeetingStatusEvent } from "../../api/client-meetings";
import type { MeetingAwareTranscriptSummary } from "./TranscriptsView";
import { TranscriptsView } from "./TranscriptsView";

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
  React.useEffect(() => {
    return client.onWsEvent("meeting-status", (data) => {
      const event = parseMeetingStatusEvent(data);
      if (!event) return;
      refresh().catch(() => {
        // Transient — the next status event or view entry re-lists.
      });
    });
  }, [refresh]);

  const onSelect = React.useCallback((id: string) => {
    setSelectedId(id);
    setSelected(null);
    client
      .getTranscript(id)
      .then((r) => setSelected(r.transcript))
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load transcript"),
      );
  }, []);

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
  );
}
