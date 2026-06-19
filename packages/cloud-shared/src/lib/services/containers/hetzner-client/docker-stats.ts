/**
 * Parser for `docker stats --no-stream --format ...` output.
 *
 * Exported separately so it can be unit-tested without spinning up
 * the full client. The size-unit table covers both decimal (kB, MB)
 * and binary (KiB, MiB) suffixes that Docker emits.
 */

import { type ContainerMetricsSnapshot, HetznerClientError } from "./types";

/** Parse the output of `docker stats --no-stream --format ...`. */
export function parseDockerStats(raw: string): ContainerMetricsSnapshot {
  const trimmed = raw.trim().split("\n").pop() ?? "";
  const [cpuPerc, memUsage, netIo, blockIo] = trimmed.split("|");
  if (!cpuPerc || !memUsage || !netIo || !blockIo) {
    throw new HetznerClientError(
      "invalid_input",
      `Failed to parse docker stats output: ${raw.slice(0, 200)}`,
    );
  }

  const cpuPercent = parseFloat(cpuPerc.replace("%", ""));
  const [memUsedRaw, memLimitRaw] = memUsage.split("/").map((s) => s.trim());
  const memoryBytes = parseSize(memUsedRaw);
  const memoryLimitBytes = parseSize(memLimitRaw);
  const [netRxRaw, netTxRaw] = netIo.split("/").map((s) => s.trim());
  const [blockReadRaw, blockWriteRaw] = blockIo.split("/").map((s) => s.trim());

  return {
    cpuPercent,
    memoryBytes,
    memoryLimitBytes,
    netRxBytes: parseSize(netRxRaw),
    netTxBytes: parseSize(netTxRaw),
    blockReadBytes: parseSize(blockReadRaw),
    blockWriteBytes: parseSize(blockWriteRaw),
    capturedAt: new Date(),
  };
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
  tib: 1_024 ** 4,
};

function parseSize(raw: string): number {
  const match = raw.match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;
  const [, n, unit] = match;
  const multiplier = unit ? (SIZE_UNITS[unit.toLowerCase()] ?? 1) : 1;
  return Math.round(parseFloat(n) * multiplier);
}
