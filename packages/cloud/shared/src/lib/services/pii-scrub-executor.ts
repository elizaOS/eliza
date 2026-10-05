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
 *   3. **Inspection scope.** `declared_candidates` judges only the caller's
 *      candidate spans (tier-0 may short-circuit). `server_discovery` requires
 *      the escalation handler to inspect the FULL content: it never takes the
 *      tier-0 shortcut, and with no handler it fails closed even when the
 *      caller declared no candidates.
 *   4. **Throw-never-fabricate.** Residue with NO escalation handler throws
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
  PiiScrubFabricationError,
  type PiiScrubResult,
  partitionScrubCandidates,
} from "@elizaos/core";
import type { PiiScrubInspectionScope } from "../../db/schemas/pii-scrub-markers";

export type { PiiScrubInspectionScope };

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
  /** How thoroughly the item must be inspected. Defaults to `declared_candidates`. */
  inspectionScope?: PiiScrubInspectionScope;
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
  /** Scope the item was actually inspected under (recorded on the marker). */
  inspectionScope: PiiScrubInspectionScope;
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
  /** `server_discovery` means: discover PII over the full `text`, not just the candidates. */
  inspectionScope: PiiScrubInspectionScope;
}) => Promise<PiiScrubResult>;

/** Executes one scrub item; the job runner drains items through this. */
export interface PiiScrubItemExecutor {
  scrubItem(input: PiiScrubExecutorInput): Promise<PiiScrubExecutorOutcome>;
}

/**
 * The escalation handler the cloud drain registers. None exists yet (the
 * server compute lanes are sibling slices of #14808), so `server_discovery`
 * jobs are refused at enqueue and fail closed at drain. Both the cron route and
 * the enqueue route read this single source.
 */
export function resolveCloudPiiScrubEscalationHandler(): PiiScrubEscalationHandler | undefined {
  return undefined;
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
      const inspectionScope = input.inspectionScope ?? "declared_candidates";
      const tier0 = detectPii(input.content);
      const { residue } = partitionScrubCandidates(
        input.candidateSpans,
        tier0.map((match) => match.value),
      );

      // Tier-0 short-circuit: nothing left for a model to judge. Only valid
      // when the job asked to judge declared candidates — server discovery
      // must always inspect the full content.
      if (residue.length === 0 && inspectionScope === "declared_candidates") {
        return {
          tier0Only: true,
          modelId: PII_SCRUB_TIER0_MODEL_ID,
          tier0SpanCount: tier0.length,
          escalatedSpanCount: 0,
          inspectionScope,
        };
      }

      // No handler is fail-closed: we cannot judge the residue (or discover
      // over the full content), so we cannot declare it clean — throw so the
      // runner quarantines the item (no done-marker, bounded retries).
      if (!escalate) {
        throw new PiiScrubFabricationError(
          inspectionScope === "server_discovery"
            ? `no PII scrub escalation handler registered but server_discovery requires full-content inspection; refusing to pass un-inspected content (itemRef=${input.itemRef})`
            : `no PII scrub escalation handler registered but ${residue.length} candidate span(s) require escalation; refusing to pass un-inspected content (itemRef=${input.itemRef})`,
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
        inspectionScope,
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
        inspectionScope,
      };
    },
  };
}
