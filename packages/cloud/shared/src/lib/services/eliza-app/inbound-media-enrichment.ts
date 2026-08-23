/**
 * Admission-gated vision enrichment for one inbound Personal Shared media
 * turn. The order is the spend boundary: the activation flag, then the
 * operator ceilings, then one primary-database transaction that claims the
 * connector message id (the enrichment idempotency record) and consumes the
 * sender and connector per-day image ceilings, and only behind a committed
 * claim the pooled-key vision call. Every outcome other than `described` is a
 * skip the caller answers with the raw media-URL text: a missing or broken
 * admission decision never spends and never fails the turn. A provider
 * redelivery of the same message reuses the stored description, waits out a
 * live claim, and never retries a terminal failure.
 */

import { ElizaError } from "@elizaos/core";
import {
  type InboundMediaDescriptionCeilings,
  type InboundMediaDescriptionClaim,
  type InboundMediaDescriptionIdentity,
  type PersonalSharedInboundMediaRepository,
  personalSharedInboundMediaRepository,
} from "../../../db/repositories/personal-shared-inbound-media";
import type { Bindings } from "../../../types/cloud-worker-env";
import { sha256Hex } from "../../oidc/crypto";
import { logger } from "../../utils/logger";
import {
  describeInboundImageMedia,
  InboundMediaDescriptionError,
  InboundMediaVisionDisabledError,
  isInboundMediaVisionEnabled,
} from "./describe-inbound-media";

/** Conversational photo volume for one account; tune per deployment via bindings. */
export const DEFAULT_INBOUND_MEDIA_SENDER_DAILY_IMAGES = 20;
/** Pooled-key spend ceiling across every sender of one connector account. */
export const DEFAULT_INBOUND_MEDIA_CONNECTOR_DAILY_IMAGES = 1_000;

export type InboundMediaEnrichmentEnv = Pick<
  Bindings,
  | "ELIZA_APP_INBOUND_MEDIA_VISION"
  | "ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES"
  | "ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES"
>;

export type InboundMediaEnrichmentSkipReason =
  | "vision_disabled"
  | "invalid_ceilings"
  | "admission_unavailable"
  | "in_flight"
  | "previously_failed"
  | "identity_mismatch"
  | "media_mismatch"
  | "exhausted"
  | "description_failed"
  | "settlement_failed";

export type InboundMediaEnrichmentOutcome =
  | { kind: "described"; description: string; reused: boolean }
  | { kind: "skipped"; reason: InboundMediaEnrichmentSkipReason };

export interface InboundMediaEnrichmentInput extends InboundMediaDescriptionIdentity {
  env: InboundMediaEnrichmentEnv;
  organizationId: string;
  userId: string;
  mediaUrls: readonly string[];
}

export interface InboundMediaEnrichmentDeps {
  repository: PersonalSharedInboundMediaRepository;
  describe: typeof describeInboundImageMedia;
}

const LOG_PREFIX = "[inbound-media-enrichment]";

function parseCeiling(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Operator ceilings for this deployment. `null` means a binding is malformed:
 * a money gate with an unreadable ceiling fails closed rather than guessing.
 */
export function resolveInboundMediaVisionCeilings(
  env: InboundMediaEnrichmentEnv,
): InboundMediaDescriptionCeilings | null {
  const senderDailyImages = parseCeiling(
    env.ELIZA_APP_INBOUND_MEDIA_VISION_SENDER_DAILY_IMAGES,
    DEFAULT_INBOUND_MEDIA_SENDER_DAILY_IMAGES,
  );
  const connectorDailyImages = parseCeiling(
    env.ELIZA_APP_INBOUND_MEDIA_VISION_CONNECTOR_DAILY_IMAGES,
    DEFAULT_INBOUND_MEDIA_CONNECTOR_DAILY_IMAGES,
  );
  if (senderDailyImages === null || connectorDailyImages === null) return null;
  return { senderDailyImages, connectorDailyImages };
}

/** Canonical unambiguous digest of the ordered URL list. */
export async function inboundMediaDigest(mediaUrls: readonly string[]): Promise<string> {
  return sha256Hex(JSON.stringify(mediaUrls));
}

async function settleClaim(
  settle: () => Promise<boolean>,
  context: Record<string, unknown>,
): Promise<boolean> {
  let settled: boolean;
  try {
    settled = await settle();
  } catch (error) {
    if (
      !(error instanceof ElizaError) ||
      error.code !== "INBOUND_MEDIA_ADMISSION_STORAGE_FAILURE"
    ) {
      throw error;
    }
    // error-policy:J4 settlement authority is unavailable, so the caller
    // keeps the raw media turn instead of trusting an uncommitted description.
    logger.error(`${LOG_PREFIX} failed to settle the description claim`, {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!settled) {
    logger.warn(`${LOG_PREFIX} description claim was reclaimed before settlement`, context);
  }
  return settled;
}

export async function enrichInboundImageMedia(
  input: InboundMediaEnrichmentInput,
  deps: InboundMediaEnrichmentDeps = {
    repository: personalSharedInboundMediaRepository,
    describe: describeInboundImageMedia,
  },
): Promise<InboundMediaEnrichmentOutcome> {
  const context = {
    platform: input.platform,
    project: input.project,
    connectorAccountId: input.connectorAccountId,
    sourceMessageId: input.sourceMessageId,
    organizationId: input.organizationId,
    userId: input.userId,
    mediaCount: input.mediaUrls.length,
  };
  if (!isInboundMediaVisionEnabled(input.env)) {
    // Disabled is the fleet default, not a fault.
    logger.debug(`${LOG_PREFIX} vision disabled for this deployment`, context);
    return { kind: "skipped", reason: "vision_disabled" };
  }
  const ceilings = resolveInboundMediaVisionCeilings(input.env);
  if (!ceilings) {
    logger.error(`${LOG_PREFIX} ceiling bindings are malformed; vision fails closed`, context);
    return { kind: "skipped", reason: "invalid_ceilings" };
  }
  let admission: Awaited<ReturnType<PersonalSharedInboundMediaRepository["admit"]>>;
  try {
    admission = await deps.repository.admit({
      platform: input.platform,
      project: input.project,
      connectorAccountId: input.connectorAccountId,
      sourceMessageId: input.sourceMessageId,
      organizationId: input.organizationId,
      userId: input.userId,
      mediaDigest: await inboundMediaDigest(input.mediaUrls),
      imageCount: input.mediaUrls.length,
      ceilings,
    });
  } catch (error) {
    if (
      !(error instanceof ElizaError) ||
      error.code !== "INBOUND_MEDIA_ADMISSION_STORAGE_FAILURE"
    ) {
      throw error;
    }
    // error-policy:J4 no admission decision means no spend: the turn keeps the
    // raw media text instead of failing or calling the provider ungated.
    logger.error(`${LOG_PREFIX} admission ledger unavailable; vision fails closed`, {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "skipped", reason: "admission_unavailable" };
  }
  switch (admission.kind) {
    case "reused":
      logger.info(`${LOG_PREFIX} reused the stored description for a redelivery`, context);
      return { kind: "described", description: admission.description, reused: true };
    case "in_flight":
      logger.warn(`${LOG_PREFIX} a live claim already covers this message`, context);
      return { kind: "skipped", reason: "in_flight" };
    case "previously_failed":
      logger.info(`${LOG_PREFIX} an earlier attempt already failed; not retrying`, {
        ...context,
        failureReason: admission.reason,
      });
      return { kind: "skipped", reason: "previously_failed" };
    case "identity_mismatch":
      logger.error(
        `${LOG_PREFIX} connector message identity belongs to a different account`,
        context,
      );
      return { kind: "skipped", reason: "identity_mismatch" };
    case "media_mismatch":
      logger.warn(
        `${LOG_PREFIX} redelivery carries different media than the stored claim`,
        context,
      );
      return { kind: "skipped", reason: "media_mismatch" };
    case "exhausted":
      logger.warn(`${LOG_PREFIX} daily image ceiling exhausted; vision denied`, {
        ...context,
        scope: admission.scope,
        limit: admission.limit,
        used: admission.used,
        requested: admission.requested,
      });
      return { kind: "skipped", reason: "exhausted" };
    case "claimed":
      return describeBehindClaim(input, deps, admission.claim, context);
  }
}

async function describeBehindClaim(
  input: InboundMediaEnrichmentInput,
  deps: InboundMediaEnrichmentDeps,
  claim: InboundMediaDescriptionClaim,
  context: Record<string, unknown>,
): Promise<InboundMediaEnrichmentOutcome> {
  const claimContext = { ...context, claimId: claim.id, attempt: claim.attempt };
  let description: string;
  try {
    description = await deps.describe(input.env, input.mediaUrls);
  } catch (error) {
    if (error instanceof InboundMediaVisionDisabledError) {
      // The flag is on but no vision provider is configured: an operator
      // misconfiguration, recorded so a redelivery does not claim again.
      await settleClaim(() => deps.repository.fail(claim, "vision_disabled"), claimContext);
      logger.error(`${LOG_PREFIX} vision enabled without a configured provider`, claimContext);
      return { kind: "skipped", reason: "vision_disabled" };
    }
    if (error instanceof InboundMediaDescriptionError) {
      // error-policy:J4 enrichment is additive: an expected fetch/vision
      // failure degrades to the raw media text instead of dropping the turn.
      // Reported here because the turn still returns success to the connector.
      await settleClaim(() => deps.repository.fail(claim, error.reason), claimContext);
      logger.error(`${LOG_PREFIX} inbound media description failed`, {
        ...claimContext,
        reason: error.reason,
        error: error.message,
      });
      return { kind: "skipped", reason: "description_failed" };
    }
    // An untyped failure is a bug; the pending claim lapses with its lease.
    throw error;
  }
  const settled = await settleClaim(
    () => deps.repository.complete(claim, description),
    claimContext,
  );
  if (!settled) {
    logger.error(
      `${LOG_PREFIX} description was not committed by the live claim; keeping raw media`,
      claimContext,
    );
    return { kind: "skipped", reason: "settlement_failed" };
  }
  logger.info(`${LOG_PREFIX} inbound media described`, claimContext);
  return { kind: "described", description, reused: false };
}
