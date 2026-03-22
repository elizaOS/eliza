import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";

export interface VerifiedTime {
  timestamp: number;
  sources: string[];
  consensus: boolean;
  deviation_ms: number;
}

/**
 * Fetches time from a single HTTP endpoint via HEAD request.
 * Returns milliseconds since epoch, or null on failure.
 *
 * NOTE (Issue 7): HTTP Date headers provide ~1 second precision only.
 * For sub-second ordering guarantees, use the full OpenTTT SDK with
 * on-chain anchoring instead of this HTTP-based provider.
 */
async function fetchTimeFromSource(
  url: string,
  label: string
): Promise<{ label: string; ts: number } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const dateHeader = res.headers.get("date");
    if (!dateHeader) return null;
    const ts = new Date(dateHeader).getTime();
    if (isNaN(ts)) return null;
    return { label, ts };
  } catch {
    return null;
  }
}

/**
 * Queries NIST, Apple, Google, and Cloudflare for the current time,
 * computes consensus median, and returns a VerifiedTime object.
 */
export async function getVerifiedTime(): Promise<VerifiedTime> {
  const sources = [
    { url: "https://time.nist.gov", label: "NIST" },
    { url: "https://www.apple.com", label: "Apple" },
    { url: "https://www.google.com", label: "Google" },
    { url: "https://www.cloudflare.com", label: "Cloudflare" },
  ];

  const results = await Promise.all(
    sources.map((s) => fetchTimeFromSource(s.url, s.label))
  );

  const valid = results.filter(
    (r): r is { label: string; ts: number } => r !== null
  );

  if (valid.length < 2) {
    // Fallback: local system time with degraded consensus flag
    return {
      timestamp: Date.now(),
      sources: ["local"],
      consensus: false,
      deviation_ms: 0,
    };
  }

  const timestamps = valid.map((r) => r.ts).sort((a, b) => a - b);
  const mid = Math.floor(timestamps.length / 2);
  const median =
    timestamps.length % 2 === 0
      ? Math.round((timestamps[mid - 1] + timestamps[mid]) / 2)
      : timestamps[mid];

  const maxDeviation = Math.max(...timestamps.map((t) => Math.abs(t - median)));

  // Consensus = all sources within 2 seconds of each other
  const consensus = maxDeviation < 2000;

  return {
    timestamp: median,
    sources: valid.map((r) => r.label),
    consensus,
    deviation_ms: maxDeviation,
  };
}

/**
 * ElizaOS Provider: injects verified multi-source time into agent context.
 * Sources: NIST, Apple, Google, Cloudflare.
 */
export const timeProvider: Provider = {
  name: "TIME_PROVIDER",
  description: "Provides verified multi-source time (NIST, Apple, Google, Cloudflare) for temporal attestation.",
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const vt = await getVerifiedTime();

    const iso = new Date(vt.timestamp).toISOString();
    const sourceList = vt.sources.join(", ");
    const consensusLabel = vt.consensus ? "CONSENSUS" : "DEGRADED";

    return {
      text: [
        `[OpenTTT TimeProvider]`,
        `Verified Time: ${iso}`,
        `Sources: ${sourceList}`,
        `Consensus: ${consensusLabel}`,
        `Max Deviation: ${vt.deviation_ms}ms`,
      ].join("\n"),
      values: {
        verifiedTimestamp: vt.timestamp,
        verifiedTimeIso: iso,
        timeSources: sourceList,
        timeConsensus: consensusLabel,
        timeDeviationMs: vt.deviation_ms,
      },
      data: { verifiedTime: vt },
    };
  },
};
