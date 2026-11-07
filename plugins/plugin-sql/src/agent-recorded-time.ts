/**
 * A recorded agent time of epoch is real. `value || Date.now()` replaced it
 * with the moment of the write.
 */
export function agentRecordedTime(value: number | bigint | null | undefined, now: number): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return now;
}
