/**
 * Ingested-transcript commitment projection (#14864). When a meeting
 * transcript is finalized and the payload identifies the owner, the owner's
 * own diarized segments run through the conservative deterministic extractor
 * so promises spoken in a meeting land in the same durable ledger as sent
 * mail and chat. Only segments attributed to the owner's entity are read —
 * other speakers' promises are their own — and hedged speech is rejected by
 * the extractor's speculative guard.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { MeetingTranscriptFinalizedPayload } from "@elizaos/shared";
import { LifeOpsRepository } from "../repository.js";
import {
  extractCommitmentLedgerRecords,
  type LifeOpsCommitmentLedgerRecord,
} from "./ledger.js";

function hasSqlAdapter(runtime: IAgentRuntime): boolean {
  const adapter = (runtime as { adapter?: { db?: unknown } }).adapter;
  return Boolean(adapter?.db);
}

/**
 * Pure projection: owner-attributed transcript segments → ledger rows.
 * Exported separately so tests can prove the attribution and speculative
 * guards without a database.
 */
export function commitmentRecordsFromTranscript(args: {
  agentId: string;
  ownerEntityId: string;
  payload: MeetingTranscriptFinalizedPayload;
}): LifeOpsCommitmentLedgerRecord[] {
  const { transcript } = args.payload;
  const records: LifeOpsCommitmentLedgerRecord[] = [];
  for (const segment of transcript.segments) {
    if (segment.speakerEntityId !== args.ownerEntityId) continue;
    const observedAt = new Date(
      transcript.createdAt + segment.startMs,
    ).toISOString();
    records.push(
      ...extractCommitmentLedgerRecords({
        agentId: args.agentId,
        source: "transcript",
        sourceKey: `${transcript.id}:${segment.id}`,
        text: segment.text,
        observedAt,
        metadata: {
          transcriptId: transcript.id,
          transcriptTitle: transcript.title,
          segmentId: segment.id,
          meetingId: args.payload.session.id,
        },
      }),
    );
  }
  return records;
}

/**
 * Runtime hook for `MEETING_TRANSCRIPT_FINALIZED_EVENT`. Skips typed-empty
 * (returns 0) when the payload carries no owner identity, no owner segments
 * produce a concrete promise, or the runtime has no SQL ledger — Wave-1
 * no-DB hosts keep working without a fake success write.
 */
export async function projectFinalizedTranscriptCommitments(
  runtime: IAgentRuntime,
  payload: MeetingTranscriptFinalizedPayload,
): Promise<number> {
  const ownerEntityId = payload.ghostAttendance?.ownerUserId;
  if (!ownerEntityId) return 0;
  if (!hasSqlAdapter(runtime)) {
    logger.debug(
      `[commitments] transcript ${payload.transcript.id} skipped ledger projection; runtime has no SQL adapter`,
    );
    return 0;
  }
  const records = commitmentRecordsFromTranscript({
    agentId: String(runtime.agentId),
    ownerEntityId,
    payload,
  });
  if (records.length === 0) return 0;
  const repository = new LifeOpsRepository(runtime);
  for (const record of records) {
    await repository.upsertCommitmentLedgerRecord(record);
  }
  logger.info(
    `[commitments] transcript ${payload.transcript.id} projected ${records.length} owner commitment row(s)`,
  );
  return records.length;
}
