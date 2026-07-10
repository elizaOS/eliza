/**
 * CLOUD-lane per-item scrub executor for the async PII scrub rails (#14808).
 *
 * Mirrors the escalation contract of the merged `PII_SCRUB` seam
 * (`packages/core/src/security/pii-scrub-seam.ts`, #14809) on the cloud job
 * runner, reusing the seam's exported primitives instead of re-implementing
 * them:
 *
 *   1. **Deterministic tier-0 floor.** `detectPii` (the same detectors the
 *      LOCAL lane runs) always executes first — structured PII the detectors
 *      fully cover completes with ZERO model calls.
 *   2. **Escalation seam.** Candidate spans NOT covered by tier-0 (the
 *      residue) go to an injected {@link PiiScrubEscalationHandler} — the plug
 *      point for the server compute lanes (Cerebras passthrough / vllm
 *      container; sibling slices of #14808). The rails never hardcode a model.
 *   3. **Throw-never-fabricate.** Residue with NO escalation handler throws
 *      `PiiScrubFabricationError` (un-inspected content is never passed as
 *      clean), and every escalation result is structurally validated with the
 *      seam's own `assertValidScrubResult` — a fabricated/mismatched "all
 *      clear" is rejected, the item stays unmarked (quarantined) and retries.
 *
 * This module is the WHAT of one item; the job runner
 * (`pii-scrub-jobs.ts`) owns the WHEN (claim/retry/resume/progress).
 */

import {
  assertValidScrubResult,
  detectPii,
  type PiiMatch,
  PiiScrubFabricationError,
  type PiiScrubResult,
} from "@elizaos/core";

/** Marker `model_id` recorded when tier-0 fully covered an item. */
export const PII_SCRUB_TIER0_MODEL_ID = "tier0";

/** One unit of scrub work handed to the executor by the job runner. */
export interface PiiScrubExecutorInput {
  /** Owning tenant — every side effect MUST stay inside this org. */
  organizationId: string;
  /** The `jobs` row being drained (observability/audit). */
  jobId: string;
  /** Caller-scoped stable item reference. */
  itemRef: string;
  /** The exact content to scrub. */
  content: string;
  /** Model-judgment candidates mined by the calling stage (may be empty). */
  candidateSpans: readonly string[];
  /** Optional retrieval context for the escalation model. Never the vault. */
  contextPack?: string;
  /** Active ruleset version (threaded into escalation + result validation). */
  rulesetVersion: string;
}

/** Outcome of a successfully scrubbed item (what the done-marker records). */
export interface PiiScrubExecutorOutcome {
  /** True when tier-0 fully covered the item and no model was called. */
  tier0Only: boolean;
  /** Model id that served the escalation, or `"tier0"` when none ran. */
  modelId: string;
  /** Number of deterministic tier-0 spans found (observability). */
  tier0SpanCount: number;
  /** Number of residue candidates escalated (0 when tier-0 covered all). */
  escalatedSpanCount: number;
}

/**
 * The server-compute plug point. Implementations judge the residue candidates
 * and return a full {@link PiiScrubResult} — or THROW. Returning a malformed
 * or partial result is rejected by `assertValidScrubResult` (fail-closed).
 */
export type PiiScrubEscalationHandler = (params: {
  organizationId: string;
  jobId: string;
  itemRef: string;
  text: string;
  candidateSpans: readonly string[];
  contextPack?: string;
  rulesetVersion: string;
}) => Promise<PiiScrubResult>;

/** Executes one scrub item; the job runner drains items through this. */
export interface PiiScrubItemExecutor {
  scrubItem(input: PiiScrubExecutorInput): Promise<PiiScrubExecutorOutcome>;
}

/**
 * True when `candidate` is already covered by a deterministic tier-0 span —
 * the same containment rule as the seam's `coveredByTier0`
 * (`packages/core/src/security/pii-scrub-seam.ts`): equal to a matched span or
 * a substring contained inside one. Covered candidates never cost a model call.
 */
function coveredByTier0(candidate: string, tier0: readonly PiiMatch[]): boolean {
  const needle = candidate.trim();
  if (needle.length === 0) return true;
  for (const match of tier0) {
    if (match.value === needle) return true;
    if (match.value.includes(needle)) return true;
  }
  return false;
}

/**
 * Build the item executor for the cloud drain. With no `escalate` handler the
 * executor serves the tier-0-only deployment: fully-covered items complete,
 * items with residue FAIL CLOSED (throw) rather than pass un-inspected.
 */
export function createPiiScrubItemExecutor(
  options: { escalate?: PiiScrubEscalationHandler } = {},
): PiiScrubItemExecutor {
  const { escalate } = options;
  return {
    async scrubItem(input: PiiScrubExecutorInput): Promise<PiiScrubExecutorOutcome> {
      const tier0 = detectPii(input.content);
      const residue = input.candidateSpans.filter((c) => !coveredByTier0(c, tier0));

      // Tier-0 short-circuit: nothing left for a model to judge.
      if (residue.length === 0) {
        return {
          tier0Only: true,
          modelId: PII_SCRUB_TIER0_MODEL_ID,
          tier0SpanCount: tier0.length,
          escalatedSpanCount: 0,
        };
      }

      // Residue with no handler is fail-closed: we cannot judge it, so we
      // cannot declare it clean — throw so the runner quarantines the item
      // (no done-marker, bounded retries, loud failure).
      if (!escalate) {
        throw new PiiScrubFabricationError(
          `no PII scrub escalation handler registered but ${residue.length} candidate span(s) require escalation; refusing to pass un-inspected content (itemRef=${input.itemRef})`,
        );
      }

      // A handler failure MUST propagate — never caught-and-defaulted to clean.
      const result = await escalate({
        organizationId: input.organizationId,
        jobId: input.jobId,
        itemRef: input.itemRef,
        text: input.content,
        candidateSpans: residue,
        contextPack: input.contextPack,
        rulesetVersion: input.rulesetVersion,
      });

      // Structural fail-closed check (the seam's own validator): rejects a
      // fabricated/mismatched "all clear", a stale-ruleset verdict, or a
      // silently-dropped candidate.
      assertValidScrubResult(result, {
        rulesetVersion: input.rulesetVersion,
        text: input.content,
        requiredSpans: residue,
      });

      return {
        tier0Only: false,
        modelId: result.modelId,
        tier0SpanCount: tier0.length,
        escalatedSpanCount: residue.length,
      };
    },
  };
}
