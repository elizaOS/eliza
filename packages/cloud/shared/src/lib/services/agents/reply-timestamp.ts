/**
 * Timestamp on an agent reply. A message created at epoch is a real time.
 * `createdAt || Date.now()` reported it as sent now.
 */
export function agentReplyTimestamp(createdAt: number | undefined, now = Date.now()): Date {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return new Date(createdAt);
  return new Date(now);
}
