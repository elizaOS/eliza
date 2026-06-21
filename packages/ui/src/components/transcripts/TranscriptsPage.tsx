/**
 * TranscriptsPage (#8789) — the data container for the Transcripts view: loads
 * the recordings list + the selected record via the client and feeds the
 * presentational {@link TranscriptsView}. Registered as the `transcripts`
 * built-in shell view.
 */

import type {
  Transcript,
  TranscriptSummary,
} from "@elizaos/shared/transcripts";
import * as React from "react";
import { client } from "../../api/client";
import { TranscriptsView } from "./TranscriptsView";

export function TranscriptsPage(): React.JSX.Element {
  const [transcripts, setTranscripts] = React.useState<TranscriptSummary[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Transcript | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    client
      .listTranscripts()
      .then((r) => {
        if (!cancelled) setTranscripts(r.transcripts);
      })
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
  }, []);

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

  return (
    <TranscriptsView
      transcripts={transcripts}
      selectedId={selectedId}
      selected={selected}
      onSelect={onSelect}
      loading={loading}
      error={error}
    />
  );
}
