import type { ModelMessage } from "ai";
import { createCompactionSummaryMessage } from "../agent/compaction";

export interface PersistedCompaction {
  firstKeptSeq: number;
  summary: string;
  tokensBefore: number;
  createdAt: Date;
}

export interface LoadedTranscriptState {
  messages: ModelMessage[];
  seqs: Array<number | null>;
  timestamps: Date[];
  compaction: PersistedCompaction | null;
}

export function buildEffectiveTranscript(
  messages: ModelMessage[],
  seqs: number[],
  timestamps: Date[],
  compaction: PersistedCompaction | null,
): LoadedTranscriptState {
  if (!compaction) {
    return {
      messages: [...messages],
      seqs: [...seqs],
      timestamps: [...timestamps],
      compaction: null,
    };
  }

  const firstKeptIndex = seqs.findIndex((seq) => seq >= compaction.firstKeptSeq);
  const keptIndex = firstKeptIndex >= 0 ? firstKeptIndex : messages.length;
  const keptMessages = messages.slice(keptIndex);
  const keptSeqs = seqs.slice(keptIndex);
  const keptTimestamps = timestamps.slice(keptIndex);

  return {
    messages: [createCompactionSummaryMessage(compaction.summary), ...keptMessages],
    seqs: [null, ...keptSeqs],
    timestamps: [compaction.createdAt, ...keptTimestamps],
    compaction,
  };
}
