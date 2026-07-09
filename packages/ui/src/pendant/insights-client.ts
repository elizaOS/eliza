/**
 * Pendant insights — the client transport.
 *
 * Thin, cancellable wrapper over `POST /api/pendant/insights`. Kept separate from
 * the scheduler so the scheduler can be tested with a fake client (no fetch) and
 * so a future non-HTTP adapter (e.g. an in-process runtime call on native) can
 * satisfy the same {@link InsightsClient} interface without touching scheduling.
 */

import {
  type PendantInsightSegmentInput,
  type PendantInsights,
  PostPendantInsightsResponseSchema,
} from "@elizaos/shared";
import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils/asset-url";

/** A skip is a legitimate "nothing to generate", not a failure to retry. */
export type InsightsClientResult =
  | { ok: true; insights: PendantInsights }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; error: string };

export interface RequestInsightsInput {
  segments: PendantInsightSegmentInput[];
  priorSummary?: string;
  maxTranscriptChars?: number;
  /** Cancels the in-flight request (e.g. on pendant disconnect). */
  signal?: AbortSignal;
}

/**
 * The adapter interface the scheduler depends on. Implement this to back the
 * scheduler with something other than the default HTTP route (tests, native).
 */
export interface InsightsClient {
  requestInsights(input: RequestInsightsInput): Promise<InsightsClientResult>;
}

/** Default HTTP-backed client against the agent route. */
export class HttpInsightsClient implements InsightsClient {
  async requestInsights(
    input: RequestInsightsInput,
  ): Promise<InsightsClientResult> {
    let res: Response;
    try {
      res = await fetchWithCsrf(resolveApiUrl("/api/pendant/insights"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          segments: input.segments,
          ...(input.priorSummary ? { priorSummary: input.priorSummary } : {}),
          ...(input.maxTranscriptChars
            ? { maxTranscriptChars: input.maxTranscriptChars }
            : {}),
        }),
        signal: input.signal,
      });
    } catch (err) {
      // Aborted fetch surfaces as an AbortError — a cancellation, not a failure.
      if (input.signal?.aborted || (err as Error)?.name === "AbortError") {
        return { ok: false, skipped: true, reason: "cancelled" };
      }
      return {
        ok: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        skipped: false,
        error: `insights ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const raw = await res.json().catch(() => null);
    const parsed = PostPendantInsightsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        skipped: false,
        error:
          parsed.error.issues[0]?.message ??
          "invalid pendant insights response",
      };
    }
    if (!parsed.data.ok) {
      return { ok: false, skipped: true, reason: parsed.data.reason };
    }
    return { ok: true, insights: parsed.data.insights };
  }
}
