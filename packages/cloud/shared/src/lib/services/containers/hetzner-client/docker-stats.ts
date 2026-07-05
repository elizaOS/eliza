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

  const cpuPercent = parseCpuPercent(cpuPerc);
  const [memUsedRaw, memLimitRaw] = parseSizePair(memUsage, "memory usage");
  const memoryBytes = parseSize(memUsedRaw);
  const memoryLimitBytes = parseSize(memLimitRaw);
  const [netRxRaw, netTxRaw] = parseSizePair(netIo, "network I/O");
  const [blockReadRaw, blockWriteRaw] = parseSizePair(blockIo, "block I/O");

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

/**
 * Strict CPU-percent parse. `parseFloat` accepts malformed partial tokens
 * (`"12.3.4%"` -> `12.3`), which would let corrupt docker output masquerade as
 * healthy metrics; a whole-token regex + `Number()` fails closed on any value
 * that is not a single well-formed decimal (throws `invalid_input`).
 */
function parseCpuPercent(raw: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)%$/);
  if (!match) {
    throw new HetznerClientError(
      "invalid_input",
      `Failed to parse docker stats CPU percent: ${JSON.stringify(raw)}`,
    );
  }
  return Number(match[1]);
}

function parseSize(raw: string): number {
  // The numeric group is a single well-formed decimal — `[\d.]+` would accept
  // `"1.2.3"`/`"."` and `parseFloat` would silently truncate them; require
  // `\d+(\.\d+)?` so any malformed size token fails closed below.
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) {
    throw new HetznerClientError(
      "invalid_input",
      `Failed to parse docker stats size field: ${JSON.stringify(raw)}`,
    );
  }
  const [, n, unit] = match;
  if (!unit) return Math.round(Number(n));
  const multiplier = SIZE_UNITS[unit.toLowerCase()];
  if (multiplier === undefined) {
    throw new HetznerClientError(
      "invalid_input",
      `Unknown size unit in docker stats output: ${JSON.stringify(unit)}`,
    );
  }
  return Math.round(Number(n) * multiplier);
}

function parseSizePair(raw: string, field: string): readonly [string, string] {
  const parts = raw.split("/").map((s) => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HetznerClientError(
      "invalid_input",
      `Failed to parse docker stats ${field}: ${JSON.stringify(raw)}`,
    );
  }
  return [parts[0], parts[1]];
}
