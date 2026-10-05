/**
 * Formats and emits the healthy development-process memory heartbeat at debug
 * level so routine telemetry stays available without crowding startup logs.
 */

interface DebugLogger {
  debug(message: string): void;
}

const bytesToMegabytes = (bytes: number): number =>
  Math.round(bytes / 1_048_576);

/** Keep forced-GC telemetry opt-in because it can pause the development host. */
export function isRoutineDevMemoryHeartbeatEnabled(
  value: string | undefined,
): boolean {
  return value === "1";
}

/** Emit a routine memory sample; threshold warnings remain owned by watchdogs. */
export function logRoutineDevMemoryHeartbeat(
  logger: DebugLogger,
  prefix: string,
  usage: NodeJS.MemoryUsage,
): void {
  logger.debug(
    `${prefix} mem rss=${bytesToMegabytes(usage.rss)}MB ` +
      `heapUsed=${bytesToMegabytes(usage.heapUsed)}MB ` +
      `heapTotal=${bytesToMegabytes(usage.heapTotal)}MB ` +
      `external=${bytesToMegabytes(usage.external)}MB ` +
      `arrayBuffers=${bytesToMegabytes(usage.arrayBuffers)}MB`,
  );
}
