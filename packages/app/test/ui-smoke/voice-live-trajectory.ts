/** Correlates live voice evidence to its conversation-scoped model trajectory. */

export interface VoiceTrajectoryCandidate {
  id?: unknown;
  startTime?: unknown;
  roomId?: unknown;
  llmCallCount?: unknown;
  metadata?: unknown;
}

export function selectVoiceTrajectory(
  candidates: VoiceTrajectoryCandidate[],
  input: { startedAt: number; roomId: string; userMessageId: string },
): VoiceTrajectoryCandidate {
  const matches = candidates.filter((candidate) => {
    const metadata =
      candidate.metadata && typeof candidate.metadata === "object"
        ? (candidate.metadata as Record<string, unknown>)
        : null;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.startTime === "number" &&
      candidate.startTime >= input.startedAt &&
      candidate.roomId === input.roomId &&
      metadata?.messageId === input.userMessageId &&
      typeof candidate.llmCallCount === "number" &&
      candidate.llmCallCount > 0
    );
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one live voice trajectory for message ${input.userMessageId} in room ${input.roomId}, found ${matches.length}: ${matches
        .map((candidate) => String(candidate.id))
        .join(", ")}`,
    );
  }
  return matches[0];
}
