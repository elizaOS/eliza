export const SIGNAL_DISCLAIMER =
  "Informational only. Not financial advice. Valhalla does not promise profit.";

export interface SignalResult {
  score: number;
  flags: string[];
  disclaimer: string;
  source: "api" | "local";
}

export function localSignal(mint: string, extraFlags: string[] = []): SignalResult {
  const flags = [
    "local fallback",
    "liquidity unknown",
    "holder concentration unknown",
    "LP status unknown",
    ...extraFlags,
  ];
  let score = 35;
  if (mint.length < 32 || mint.length > 44) {
    flags.push("unexpected address length");
    score = 20;
  }
  return { score, flags, disclaimer: SIGNAL_DISCLAIMER, source: "local" };
}

export async function signalScore(
  mint: string,
  env: { url?: string; key?: string },
  fetcher: typeof fetch = fetch
): Promise<SignalResult> {
  const url = (env.url ?? "").trim().replace(/\/$/, "");
  const key = (env.key ?? "").trim();
  const allowed =
    url.startsWith("https://") ||
    url.startsWith("http://127.0.0.1") ||
    url.startsWith("http://localhost");
  if (!url || !key || !allowed) return localSignal(mint);
  try {
    const response = await fetcher(`${url}/v1/score/${encodeURIComponent(mint)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) return localSignal(mint, [`api HTTP ${response.status}`]);
    const body = (await response.json()) as {
      score?: number;
      flags?: string[];
      disclaimer?: string;
    };
    const score = Number(body.score);
    if (!Number.isFinite(score)) return localSignal(mint, ["api score missing"]);
    return {
      score: Math.max(0, Math.min(100, score)),
      flags: Array.isArray(body.flags) ? body.flags.map(String) : [],
      disclaimer: body.disclaimer || SIGNAL_DISCLAIMER,
      source: "api",
    };
  } catch {
    return localSignal(mint, ["api did not answer"]);
  }
}
