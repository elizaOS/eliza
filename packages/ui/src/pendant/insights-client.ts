/**
 * Cancellable browser transport for the tenant-scoped pendant insight route.
 *
 * Request and response boundaries are schema-validated. Transport, body-read,
 * JSON, and schema failures remain explicit so malformed model/server output can
 * never masquerade as a healthy empty rollup.
 */

import {
  type PendantInsightSegmentInput,
  type PendantInsights,
  type PendantInsightsProvenance,
  PostPendantInsightsResponseSchema,
} from "@elizaos/shared";
import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils/asset-url";

export type InsightsClientResult =
  | {
      ok: true;
      insights: PendantInsights;
      provenance: PendantInsightsProvenance;
    }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; error: string };

export interface RequestInsightsInput {
  sessionId: string;
  segments: PendantInsightSegmentInput[];
  priorSummary?: string;
  maxTranscriptChars?: number;
  signal?: AbortSignal;
}

export interface InsightsClient {
  requestInsights(input: RequestInsightsInput): Promise<InsightsClientResult>;
}

export class HttpInsightsClient implements InsightsClient {
  async requestInsights(
    input: RequestInsightsInput,
  ): Promise<InsightsClientResult> {
    let response: Response;
    try {
      response = await fetchWithCsrf(resolveApiUrl("/api/pendant/insights"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          enabled: true,
          sessionId: input.sessionId,
          segments: input.segments,
          ...(input.priorSummary ? { priorSummary: input.priorSummary } : {}),
          ...(input.maxTranscriptChars
            ? { maxTranscriptChars: input.maxTranscriptChars }
            : {}),
        }),
        signal: input.signal,
      });
    } catch (err) {
      // error-policy:J1 fetch boundary distinguishes user cancellation from a transport failure.
      if (input.signal?.aborted || (err as Error)?.name === "AbortError") {
        return { ok: false, skipped: true, reason: "cancelled" };
      }
      return {
        ok: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (err) {
      // error-policy:J1 response boundary surfaces an unreadable body as failure.
      return {
        ok: false,
        skipped: false,
        error: `failed to read insights response: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        error: `insights ${response.status}: ${bodyText.slice(0, 200)}`,
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch (err) {
      // error-policy:J3 server JSON is untrusted input and malformed data is an explicit invalid result.
      return {
        ok: false,
        skipped: false,
        error: `invalid pendant insights JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
    return {
      ok: true,
      insights: parsed.data.insights,
      provenance: parsed.data.provenance,
    };
  }
}
