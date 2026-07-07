/**
 * Runtime consumer that turns a finalized meeting transcript into queued owner
 * approvals — the reachable path that makes `analyzeMeetingGhostTranscript`
 * (a pure function in `./index.ts`) act on the system.
 *
 * A caller (the meeting post-processing hook, or a scheduled-task watcher that
 * reads finalized `TranscriptSegment[]` off the `transcripts` memory table)
 * hands us the diarized transcript the owner skipped plus their context. We
 * derive the follow-up emails and calendar-deadline events the owner would send
 * if they had attended, and enqueue each as an owner-approval request through
 * the shared `ApprovalQueue` — every meeting-ghost side effect stays behind the
 * owner's one-tap approve/reject, never auto-sent.
 *
 * `analyzeMeetingGhostTranscript` already emits `ApprovalEnqueueInput[]`, so
 * this is a thin routing pass: analyze, then `enqueue` each request. Enqueue
 * failures surface (no swallow) so a broken approval pipeline is observable.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createApprovalQueue } from "../approval-queue.js";
import type { ApprovalRequest } from "../approval-queue.types.js";
import {
  analyzeMeetingGhostTranscript,
  type MeetingGhostAnalysis,
  type MeetingGhostOwnerContext,
  type MeetingGhostTranscript,
} from "./index.js";

export interface RunMeetingGhostInput {
  readonly agentId: string;
  readonly transcript: MeetingGhostTranscript;
  readonly owner: MeetingGhostOwnerContext;
}

export interface MeetingGhostRunResult {
  readonly analysis: MeetingGhostAnalysis;
  /** Approval requests created in the queue (follow-ups then calendar deadlines). */
  readonly enqueued: readonly ApprovalRequest[];
}

/**
 * Analyze the transcript and enqueue every derived owner-approval request.
 * Follow-up emails enqueue before calendar-deadline events so the owner sees
 * the reply drafts first. Returns the analysis alongside the created requests
 * so callers can render the digest and cite the queued approvals.
 */
export async function runMeetingGhostForTranscript(
  runtime: IAgentRuntime,
  input: RunMeetingGhostInput,
): Promise<MeetingGhostRunResult> {
  const analysis = analyzeMeetingGhostTranscript({
    transcript: input.transcript,
    owner: input.owner,
  });

  const requests = [
    ...analysis.followUpApprovals,
    ...analysis.calendarIntents.map((intent) => intent.approval),
  ];

  const queue = createApprovalQueue(runtime, { agentId: input.agentId });
  const enqueued: ApprovalRequest[] = [];
  for (const request of requests) {
    enqueued.push(await queue.enqueue(request));
  }

  logger.info(
    `[meeting-ghost] ${input.transcript.meetingId}: ${analysis.decisions.length} decisions, ${analysis.commitments.length} commitments, ${enqueued.length} approvals queued`,
  );

  return { analysis, enqueued };
}
