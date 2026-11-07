/** Count/hash-only diagnostics at the existing evaluator recording boundary.
 * Cost: linear source/segment passes and hashes, no I/O/model/cache. No original
 * IDs, labels, provider names, body text, selection IDs or errors are emitted.
 * Fallback reasons describe the stored selection here, not an earlier offer
 * already rejected/cleared by the planner. */
import {
  type ContextObject,
  type ContextObjectPromptSegment,
  completionContextSources,
  hashString,
  isObjectRecord,
  parseCompletionContextSelection,
  segmentBlock,
} from "@elizaos/core";

type SegmentKind =
  | "system"
  | "character"
  | "history"
  | "current_request"
  | "provider"
  | "routing"
  | "instruction"
  | "runtime_evidence"
  | "other";
type Size = {
  count: number;
  contentUTF8Bytes: number;
  renderedUTF8Bytes: number;
  orderedSHA256: string;
};
export type EvaluatorContextAttribution =
  | { version: 1; status: "unavailable" }
  | {
      version: 1;
      status: "available";
      selection: {
        mode: string;
        complete: boolean;
        projectionApplied: boolean;
        reason: string;
        originalSources: number;
        omittedSources: number;
        requestedRelevant: number;
        requestedConstraints: number;
        requestedReferents: number;
        requestedPending: number;
        offeredSourceSetSHA256: string | null;
        acceptedSourceSetSHA256: string | null;
        currentSourceSetSHA256: string;
        sourceSetMatches: boolean;
      };
      background: { applied: boolean; omittedSources: number };
      deferredProviderCount: number;
      segments: Partial<Record<SegmentKind, Size>>;
      stageInstructions: Size;
      decisionState: Size;
    };
const bytes = (s: string) => new TextEncoder().encode(s).length;
const single = (content: string): Size => ({
  count: 1,
  contentUTF8Bytes: bytes(content),
  renderedUTF8Bytes: bytes(content),
  orderedSHA256: hashString(content),
});
export function describeEvaluatorContext(args: {
  original: ContextObject;
  projection: { applied: boolean; omittedSourceCount: number };
  background: { applied: boolean; omittedSourceCount: number };
  deferredProviderCount: number;
  segments: readonly ContextObjectPromptSegment[];
  instructions: string;
  decisionState: string;
}): EvaluatorContextAttribution {
  try {
    const offered = parseCompletionContextSelection(
        args.original.metadata?.completionContext,
      ),
      snapshot = completionContextSources(args.original),
      ids = new Set(snapshot.sources.map((source) => source.id));
    const requested = offered
      ? [
          ...offered.relevantSourceIds,
          ...offered.constraintSourceIds,
          ...offered.referentSourceIds,
          ...offered.pendingIntentSourceIds,
        ]
      : [];
    const matches = offered?.sourceSetId === snapshot.sourceSetId;
    const reason = args.projection.applied
      ? "accepted_selected"
      : !offered
        ? args.original.metadata?.completionContext === undefined
          ? "missing"
          : "invalid"
        : offered.mode !== "selected"
          ? "full_requested"
          : !offered.complete
            ? "incomplete"
            : !snapshot.sources.length
              ? "no_history"
              : !matches
                ? "stale_source_set"
                : requested.some((id) => !ids.has(id))
                  ? "unknown_source"
                  : "all_history_selected";
    const events = new Map(
        args.original.events.map((event) => [event.id, event]),
      ),
      duplicate = new Set<string>(),
      seen = new Set<string>();
    for (const event of args.original.events) {
      if (seen.has(event.id)) duplicate.add(event.id);
      seen.add(event.id);
    }
    const buckets = new Map<
      SegmentKind,
      { content: number; rendered: number; hashes: string[] }
    >();
    for (const segment of args.segments) {
      const event =
        segment.id && !duplicate.has(segment.id)
          ? events.get(segment.id)
          : undefined;
      let kind: SegmentKind = "other";
      if (event) {
        if (event.type === "segment" && event.source === "prior-dialogue")
          kind = "history";
        else if (
          event.type === "message" &&
          event.id === args.original.metadata?.messageId
        )
          kind = "current_request";
        else if (event.type === "provider") kind = "provider";
        else if (event.type === "message_handler") kind = "routing";
        else if (event.type === "instruction") kind = "instruction";
        else kind = "runtime_evidence";
      } else if (
        segment.id &&
        !duplicate.has(segment.id) &&
        segment.id === args.original.staticPrefix?.systemPrompt?.id
      )
        kind = "system";
      else if (
        segment.id &&
        !duplicate.has(segment.id) &&
        segment.id === args.original.staticPrefix?.characterPrompt?.id
      )
        kind = "character";
      else if (
        segment.id &&
        !duplicate.has(segment.id) &&
        (segment.id === "selected-contexts" ||
          segment.id === "context-definitions")
      )
        kind = "routing";
      const rendered = segmentBlock(segment),
        bucket = buckets.get(kind) ?? { content: 0, rendered: 0, hashes: [] };
      bucket.content += bytes(segment.content);
      bucket.rendered += bytes(rendered);
      bucket.hashes.push(
        hashString(JSON.stringify([segment.stable, rendered])),
      );
      buckets.set(kind, bucket);
    }
    const segments: Partial<Record<SegmentKind, Size>> = {};
    for (const [kind, bucket] of buckets)
      segments[kind] = {
        count: bucket.hashes.length,
        contentUTF8Bytes: bucket.content,
        renderedUTF8Bytes: bucket.rendered,
        orderedSHA256: hashString(JSON.stringify(bucket.hashes)),
      };
    return {
      version: 1,
      status: "available",
      selection: {
        mode: offered?.mode ?? "none",
        complete: offered?.complete ?? false,
        projectionApplied: args.projection.applied,
        reason,
        originalSources: snapshot.sources.length,
        omittedSources: args.projection.omittedSourceCount,
        requestedRelevant: offered?.relevantSourceIds.length ?? 0,
        requestedConstraints: offered?.constraintSourceIds.length ?? 0,
        requestedReferents: offered?.referentSourceIds.length ?? 0,
        requestedPending: offered?.pendingIntentSourceIds.length ?? 0,
        offeredSourceSetSHA256: offered
          ? hashString(offered.sourceSetId)
          : null,
        acceptedSourceSetSHA256:
          args.projection.applied && offered
            ? hashString(offered.sourceSetId)
            : null,
        currentSourceSetSHA256: hashString(snapshot.sourceSetId),
        sourceSetMatches: matches,
      },
      background: {
        applied: args.background.applied,
        omittedSources: args.background.omittedSourceCount,
      },
      deferredProviderCount: args.deferredProviderCount,
      segments,
      stageInstructions: single(args.instructions),
      decisionState: single(args.decisionState),
    };
  } catch {
    return { version: 1, status: "unavailable" };
  }
}
export type PlannerSourceReviewAttribution =
  | { version: 1; status: "unavailable" }
  | {
      version: 1;
      status: "available";
      newReviewOffered: boolean;
      submissionPresent: boolean;
      previousProjectionApplied: boolean;
      acceptedProjection: boolean;
      reason: string;
      offeredSourceSetSHA256: string | null;
      submittedSourceSetSHA256: string | null;
      previousStoredSourceSetSHA256: string | null;
      currentSourceSetSHA256: string;
      acceptedSourceSetSHA256: string | null;
      sourceSetMatches: boolean;
      requestedRelevant: number;
      requestedConstraints: number;
      requestedReferents: number;
      requestedPending: number;
    };
/** Explain only the existing acceptance decision before the stored selection
 * is replaced. This never changes selection, context, calls or restoration. */
export function describePlannerSourceReview(args: {
  original: ContextObject;
  newReview: boolean;
  submitted: boolean;
  selection: unknown;
  previousApplied: boolean;
  unanimous: boolean;
  accepted: unknown;
  offeredSourceSetId: unknown;
}): PlannerSourceReviewAttribution {
  try {
    const selected = parseCompletionContextSelection(args.selection),
      previous = parseCompletionContextSelection(
        args.original.metadata?.completionContext,
      ),
      accepted = parseCompletionContextSelection(args.accepted),
      snapshot = completionContextSources(args.original),
      current = snapshot.sourceSetId,
      knownIds = new Set(snapshot.sources.map((source) => source.id));
    const selectedIds = selected
      ? [
          ...selected.relevantSourceIds,
          ...selected.constraintSourceIds,
          ...selected.referentSourceIds,
          ...selected.pendingIntentSourceIds,
        ]
      : [];
    const offered =
      typeof args.offeredSourceSetId === "string" &&
      /^[0-9a-f]{64}$/.test(args.offeredSourceSetId)
        ? args.offeredSourceSetId
        : undefined;
    const reason = accepted
      ? "accepted_selected"
      : args.original.metadata?.plannerQueryTokensRestored === true
        ? "history_restored"
        : args.newReview && !args.submitted
          ? "offered_review_omitted"
          : !selected
            ? "missing_or_invalid_selection"
            : selected.mode !== "selected" || !selected.complete
              ? "full_or_incomplete_review"
              : !args.unanimous
                ? "nonunanimous"
                : selected.sourceSetId !== current
                  ? "stale_source_set"
                  : !snapshot.sources.length
                    ? "no_history"
                    : selectedIds.some((id) => !knownIds.has(id))
                      ? "unknown_source"
                      : new Set(selectedIds).size === snapshot.sources.length
                        ? "all_history_selected"
                        : "review_not_applied";
    return {
      version: 1,
      status: "available",
      newReviewOffered: args.newReview,
      submissionPresent: args.submitted,
      previousProjectionApplied: args.previousApplied,
      acceptedProjection: !!accepted,
      reason,
      offeredSourceSetSHA256: offered ? hashString(offered) : null,
      submittedSourceSetSHA256: selected
        ? hashString(selected.sourceSetId)
        : null,
      previousStoredSourceSetSHA256: previous
        ? hashString(previous.sourceSetId)
        : null,
      currentSourceSetSHA256: hashString(current),
      acceptedSourceSetSHA256: accepted
        ? hashString(accepted.sourceSetId)
        : null,
      sourceSetMatches: !!selected && selected.sourceSetId === current,
      requestedRelevant: selected?.relevantSourceIds.length ?? 0,
      requestedConstraints: selected?.constraintSourceIds.length ?? 0,
      requestedReferents: selected?.referentSourceIds.length ?? 0,
      requestedPending: selected?.pendingIntentSourceIds.length ?? 0,
    };
  } catch {
    return { version: 1, status: "unavailable" };
  }
}
/** Stored on the existing stage record only; never sent as provider input. */
export function contextDiagnosticOptions(
  options: Record<string, unknown> | undefined,
  attribution:
    | EvaluatorContextAttribution
    | PlannerSourceReviewAttribution
    | undefined,
  key:
    | "evaluatorContextAttribution"
    | "plannerSourceSelection" = "evaluatorContextAttribution",
): Record<string, unknown> | undefined {
  if (!attribution) return options;
  return {
    ...options,
    eliza: {
      ...(isObjectRecord(options?.eliza) ? options.eliza : {}),
      [key]: attribution,
    },
  };
}
