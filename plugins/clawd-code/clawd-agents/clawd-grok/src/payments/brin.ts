const BRIN_API_BASE = "https://api.brin.sh";
const DEFAULT_TIMEOUT_MS = 2_000;

export interface BrinThreat {
  type: string;
  severity: string;
  detail: string;
}

export interface BrinSubScores {
  identity: number | null;
  behavior: number | null;
  content: number | null;
  graph: number | null;
}

export interface BrinScanResult {
  score: number;
  verdict: "safe" | "caution" | "suspicious" | "dangerous";
  confidence: "high" | "medium" | "low";
  url?: string;
  subScores?: BrinSubScores;
  threats?: BrinThreat[];
}

/**
 * Scan a URL's domain via the brin API with expanded details.
 * Returns `null` when brin is unreachable or returns an unexpected response
 * so callers can gracefully degrade.
 */
export async function scanUrl(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BrinScanResult | null> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }

  try {
    const response = await fetch(`${BRIN_API_BASE}/domain/${hostname}?details=true`, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.score !== "number" || typeof data.verdict !== "string") return null;

    const result: BrinScanResult = {
      score: data.score,
      verdict: data.verdict as BrinScanResult["verdict"],
      confidence: (typeof data.confidence === "string" ? data.confidence : "low") as BrinScanResult["confidence"],
      url: typeof data.url === "string" ? data.url : `${BRIN_API_BASE}/domain/${hostname}`,
    };

    const subScores = data.sub_scores;
    if (subScores && typeof subScores === "object") {
      const ss = subScores as Record<string, unknown>;
      result.subScores = {
        identity: typeof ss.identity === "number" ? ss.identity : null,
        behavior: typeof ss.behavior === "number" ? ss.behavior : null,
        content: typeof ss.content === "number" ? ss.content : null,
        graph: typeof ss.graph === "number" ? ss.graph : null,
      };
    }

    const threats = data.threats;
    if (Array.isArray(threats) && threats.length > 0) {
      result.threats = threats
        .filter(
          (t: unknown): t is Record<string, unknown> =>
            typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).type === "string",
        )
        .map((t) => ({
          type: String(t.type),
          severity: typeof t.severity === "string" ? t.severity : "unknown",
          detail: typeof t.detail === "string" ? t.detail : "",
        }));
    }

    return result;
  } catch {
    return null;
  }
}
