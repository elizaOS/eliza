/**
 * Owns durable, tenant-scoped Stripe Customer creation and crash reconciliation.
 * Provider metadata is a lookup hint; the attempt row and canonical organization row are authority.
 */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { writeTransaction } from "../../db/helpers";
import { organizations } from "../../db/schemas/organizations";
import {
  type StripeCustomerAttempt,
  stripeCustomerAttempts,
  stripeCustomerLegacyQuarantines,
} from "../../db/schemas/stripe-customer-attempts";
import { requireStripe } from "../stripe";

const PROVIDER_REUSE_WINDOW_MS = 23 * 60 * 60 * 1000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const WAIT_STEP_MS = 25;

export type StripeCustomerCallerIntent =
  | "payment_method"
  | "interactive_checkout"
  | "credit_checkout"
  | "auto_top_up";

export interface StripeCustomerCandidate {
  id: string;
  metadata: Record<string, string>;
  created: number;
  livemode: boolean;
}

export type StripeCustomerLookup =
  | { kind: "found"; candidate: StripeCustomerCandidate }
  | { kind: "absent"; customerId: string; reason: "missing" | "deleted" };

export interface StripeCustomerProvider {
  searchByAttemptId(attemptId: string): Promise<StripeCustomerCandidate[]>;
  retrieve(customerId: string): Promise<StripeCustomerLookup>;
  create(
    params: Stripe.CustomerCreateParams,
    idempotencyKey: string,
  ): Promise<StripeCustomerCandidate>;
}

export class StripeCustomerAuthorityError extends ElizaError {
  override readonly name = "StripeCustomerAuthorityError";

  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message, { code, context, severity: "fatal" });
  }
}

class LiveStripeCustomerProvider implements StripeCustomerProvider {
  async searchByAttemptId(attemptId: string): Promise<StripeCustomerCandidate[]> {
    const stripe = requireStripe();
    const candidates: StripeCustomerCandidate[] = [];
    let page: string | undefined;
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const result = await stripe.customers.search({
        query: `metadata['eliza_customer_attempt_id']:'${attemptId}'`,
        limit: 100,
        ...(page ? { page } : {}),
      });
      candidates.push(
        ...result.data.map((customer) => ({
          id: customer.id,
          metadata: customer.metadata,
          created: customer.created,
          livemode: customer.livemode,
        })),
      );
      if (!result.has_more) return candidates;
      if (!result.next_page) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_SEARCH_BOUND",
          "Stripe Customer search pagination did not provide a continuation",
        );
      }
      page = result.next_page;
    }
    throw new StripeCustomerAuthorityError(
      "STRIPE_CUSTOMER_SEARCH_BOUND",
      "Stripe Customer reconciliation exceeded its bounded search",
    );
  }

  async retrieve(customerId: string): Promise<StripeCustomerLookup> {
    try {
      const customer = await requireStripe().customers.retrieve(customerId);
      if (customer.deleted) return { kind: "absent", customerId, reason: "deleted" };
      return {
        kind: "found",
        candidate: {
          id: customer.id,
          metadata: customer.metadata,
          created: customer.created,
          livemode: customer.livemode,
        },
      };
    } catch (error) {
      // error-policy:J1 Stripe's resource-missing boundary becomes explicit retirement evidence.
      if (
        error instanceof Error &&
        "code" in error &&
        (error as Error & { code?: string }).code === "resource_missing"
      ) {
        return { kind: "absent", customerId, reason: "missing" };
      }
      throw error;
    }
  }

  async create(
    params: Stripe.CustomerCreateParams,
    idempotencyKey: string,
  ): Promise<StripeCustomerCandidate> {
    const customer = await requireStripe().customers.create(params, { idempotencyKey });
    return {
      id: customer.id,
      metadata: customer.metadata,
      created: customer.created,
      livemode: customer.livemode,
    };
  }
}

interface ClaimedAttempt {
  kind: "claimed";
  attempt: StripeCustomerAttempt;
  leaseToken: string;
  organizationName: string;
  billingEmail: string | null;
  legacyCustomerId?: string;
}

interface BusyAttempt {
  kind: "busy";
}

interface ExistingCustomer {
  kind: "existing";
  customerId: string;
}

type ClaimResult = ClaimedAttempt | BusyAttempt | ExistingCustomer;

function requestDigest(input: {
  organizationId: string;
  generation: number;
  organizationName: string;
  billingEmail: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: "stripe",
        organizationId: input.organizationId,
        generation: input.generation,
        organizationName: input.organizationName.trim(),
        billingEmail: input.billingEmail?.trim().toLowerCase() ?? null,
      }),
    )
    .digest("hex");
}

function authorityMetadata(attempt: StripeCustomerAttempt): Record<string, string> {
  return {
    organization_id: attempt.organization_id,
    eliza_organization_id: attempt.organization_id,
    eliza_customer_attempt_id: attempt.id,
    eliza_customer_generation: String(attempt.generation),
    eliza_customer_request_digest: attempt.request_digest,
    eliza_customer_provider: "stripe",
  };
}

function candidateMatches(attempt: StripeCustomerAttempt, candidate: StripeCustomerCandidate) {
  const expected = authorityMetadata(attempt);
  return Object.entries(expected).every(([key, value]) => candidate.metadata[key] === value);
}

function legacyCandidateMatches(
  organizationId: string,
  expectedCustomerId: string,
  candidate: StripeCustomerCandidate,
) {
  return (
    candidate.id === expectedCustomerId &&
    candidate.metadata.organization_id === organizationId &&
    (!candidate.metadata.eliza_organization_id ||
      candidate.metadata.eliza_organization_id === organizationId)
  );
}

export class StripeCustomerAuthorityService {
  constructor(
    private readonly provider: StripeCustomerProvider = new LiveStripeCustomerProvider(),
    private readonly options: {
      now?: () => Date;
      leaseMs?: number;
      waitMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async claim(
    organizationId: string,
    callerIntent: StripeCustomerCallerIntent,
  ): Promise<ClaimResult> {
    const now = this.now();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + (this.options.leaseMs ?? DEFAULT_LEASE_MS));
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({
          id: organizations.id,
          name: organizations.name,
          billing_email: organizations.billing_email,
          stripe_customer_id: organizations.stripe_customer_id,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for("update")
        .limit(1);
      if (!organization) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_ORGANIZATION_MISSING",
          "Stripe Customer organization does not exist",
          { organizationId },
        );
      }
      let [attempt] = await tx
        .select()
        .from(stripeCustomerAttempts)
        .where(eq(stripeCustomerAttempts.organization_id, organizationId))
        .orderBy(desc(stripeCustomerAttempts.generation))
        .for("update")
        .limit(1);
      let legacyCustomerId: string | undefined;
      if (organization.stripe_customer_id) {
        if (
          attempt?.status === "bound" &&
          attempt.provider_customer_id === organization.stripe_customer_id &&
          attempt.provider_receipt?.customer_id === organization.stripe_customer_id
        ) {
          return { kind: "existing", customerId: organization.stripe_customer_id };
        }
        const [legacyQuarantine] = await tx
          .select()
          .from(stripeCustomerLegacyQuarantines)
          .where(eq(stripeCustomerLegacyQuarantines.organization_id, organizationId))
          .for("update")
          .limit(1);
        if (
          !legacyQuarantine ||
          legacyQuarantine.stripe_customer_id !== organization.stripe_customer_id ||
          legacyQuarantine.resolved_attempt_id
        ) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_UNVERIFIED_LOCAL_BINDING",
            "Organization Stripe Customer lacks unresolved legacy verification authority",
            { organizationId, attemptId: attempt?.id },
          );
        }
        legacyCustomerId = organization.stripe_customer_id;
      }
      if (attempt?.status === "quarantined") {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_QUARANTINED",
          "Stripe Customer attempt requires operator reconciliation",
          { organizationId, attemptId: attempt.id },
        );
      }
      if (attempt?.status === "abandoned" || attempt?.status === "bound") {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_ATTEMPT_INCONSISTENT",
          "Latest Stripe Customer attempt does not match organization authority",
          { organizationId, attemptId: attempt.id, status: attempt.status },
        );
      }
      if (!attempt) {
        const generation = 1;
        const id = randomUUID();
        const digest = requestDigest({
          organizationId,
          generation,
          organizationName: organization.name,
          billingEmail: organization.billing_email,
        });
        [attempt] = await tx
          .insert(stripeCustomerAttempts)
          .values({
            id,
            organization_id: organizationId,
            generation,
            request_digest: digest,
            caller_intent: callerIntent,
            idempotency_key: `eliza-customer-attempt:${id}`,
            status: "prepared",
          })
          .returning();
      }
      if (!attempt) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_ATTEMPT_CREATE_FAILED",
          "Stripe Customer attempt could not be persisted",
        );
      }
      const currentDigest = requestDigest({
        organizationId,
        generation: attempt.generation,
        organizationName: organization.name,
        billingEmail: organization.billing_email,
      });
      if (attempt.request_digest !== currentDigest) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_REQUEST_DRIFT",
          "Stripe Customer authority inputs changed during recovery",
          { organizationId, attemptId: attempt.id },
        );
      }
      if (
        attempt.lease_token &&
        attempt.lease_expires_at &&
        attempt.lease_expires_at.getTime() > now.getTime()
      ) {
        return { kind: "busy" };
      }
      const [claimed] = await tx
        .update(stripeCustomerAttempts)
        .set({
          status: "provider_started",
          provider_started_at: attempt.provider_started_at ?? now,
          lease_token: leaseToken,
          lease_expires_at: leaseExpiresAt,
          ambiguous_reason: null,
          updated_at: now,
        })
        .where(eq(stripeCustomerAttempts.id, attempt.id))
        .returning();
      if (!claimed) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_LEASE_RACE",
          "Stripe Customer attempt lease could not be acquired",
        );
      }
      return {
        kind: "claimed",
        attempt: claimed,
        leaseToken,
        organizationName: organization.name,
        billingEmail: organization.billing_email,
        ...(legacyCustomerId ? { legacyCustomerId } : {}),
      };
    });
  }

  private async markAmbiguous(
    attemptId: string,
    leaseToken: string,
    reason: string,
  ): Promise<void> {
    await writeTransaction(async (tx) => {
      await tx
        .update(stripeCustomerAttempts)
        .set({
          status: "provider_ambiguous",
          ambiguous_reason: reason.slice(0, 500),
          lease_token: null,
          lease_expires_at: null,
          updated_at: this.now(),
        })
        .where(
          and(
            eq(stripeCustomerAttempts.id, attemptId),
            eq(stripeCustomerAttempts.lease_token, leaseToken),
          ),
        );
    });
  }

  private async releaseResolutionLease(
    attemptId: string,
    leaseToken: string,
    reason: string,
  ): Promise<void> {
    await writeTransaction(async (tx) => {
      await tx
        .update(stripeCustomerAttempts)
        .set({
          ambiguous_reason: reason.slice(0, 500),
          lease_token: null,
          lease_expires_at: null,
          updated_at: this.now(),
        })
        .where(
          and(
            eq(stripeCustomerAttempts.id, attemptId),
            eq(stripeCustomerAttempts.lease_token, leaseToken),
          ),
        );
    });
  }

  private async quarantine(attemptId: string, leaseToken: string, reason: string): Promise<never> {
    await writeTransaction(async (tx) => {
      await tx
        .update(stripeCustomerAttempts)
        .set({
          status: "quarantined",
          ambiguous_reason: reason.slice(0, 500),
          lease_token: null,
          lease_expires_at: null,
          updated_at: this.now(),
        })
        .where(
          and(
            eq(stripeCustomerAttempts.id, attemptId),
            eq(stripeCustomerAttempts.lease_token, leaseToken),
          ),
        );
    });
    throw new StripeCustomerAuthorityError(
      "STRIPE_CUSTOMER_QUARANTINED",
      "Stripe Customer reconciliation found conflicting provider authority",
      { attemptId, reason },
    );
  }

  private async retireLegacyCustomer(
    claimed: ClaimedAttempt,
    evidence:
      | { kind: "missing" | "deleted"; customerId: string }
      | { kind: "wrong_tenant"; customerId: string; providerOrganizationId: string },
  ): Promise<void> {
    if (!claimed.legacyCustomerId || evidence.customerId !== claimed.legacyCustomerId) {
      return this.quarantine(
        claimed.attempt.id,
        claimed.leaseToken,
        "legacy retirement evidence did not identify the exact published Customer",
      );
    }
    await writeTransaction(async (tx) => {
      const now = this.now();
      const [organization] = await tx
        .select({ stripe_customer_id: organizations.stripe_customer_id })
        .from(organizations)
        .where(eq(organizations.id, claimed.attempt.organization_id))
        .for("update")
        .limit(1);
      const [attempt] = await tx
        .select()
        .from(stripeCustomerAttempts)
        .where(eq(stripeCustomerAttempts.id, claimed.attempt.id))
        .for("update")
        .limit(1);
      const [quarantine] = await tx
        .select()
        .from(stripeCustomerLegacyQuarantines)
        .where(eq(stripeCustomerLegacyQuarantines.organization_id, claimed.attempt.organization_id))
        .for("update")
        .limit(1);
      if (
        !organization ||
        !attempt ||
        !quarantine ||
        organization.stripe_customer_id !== evidence.customerId ||
        quarantine.stripe_customer_id !== evidence.customerId ||
        quarantine.resolved_attempt_id ||
        attempt.lease_token !== claimed.leaseToken
      ) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_LEGACY_RETIREMENT_FENCE_LOST",
          "Legacy Stripe Customer retirement authority changed during provider lookup",
        );
      }
      if (
        evidence.kind === "wrong_tenant" &&
        evidence.providerOrganizationId === attempt.organization_id
      ) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_LEGACY_RETIREMENT_INVALID",
          "A valid tenant Customer cannot be retired as wrong-tenant",
        );
      }
      const generation = attempt.generation + 1;
      const replacementId = randomUUID();
      const digest = requestDigest({
        organizationId: attempt.organization_id,
        generation,
        organizationName: claimed.organizationName,
        billingEmail: claimed.billingEmail,
      });
      await tx
        .update(stripeCustomerAttempts)
        .set({
          status: "abandoned",
          lease_token: null,
          lease_expires_at: null,
          resolved_by: "system:stripe-customer-authority",
          resolution_reason: `provider-verified legacy Customer ${evidence.kind}`,
          resolved_at: now,
          updated_at: now,
        })
        .where(eq(stripeCustomerAttempts.id, attempt.id));
      await tx.insert(stripeCustomerAttempts).values({
        id: replacementId,
        organization_id: attempt.organization_id,
        generation,
        request_digest: digest,
        caller_intent: attempt.caller_intent,
        idempotency_key: `eliza-customer-attempt:${replacementId}`,
        status: "prepared",
      });
      const retirementReceipt = {
        customer_id: evidence.customerId,
        outcome: evidence.kind,
        observed_at: now.toISOString(),
        provider_metadata:
          evidence.kind === "wrong_tenant"
            ? { organization_id: evidence.providerOrganizationId }
            : null,
      };
      await tx
        .update(stripeCustomerLegacyQuarantines)
        .set({
          resolved_attempt_id: attempt.id,
          resolved_by: "system:stripe-customer-authority",
          resolution_reason: `provider-verified legacy Customer ${evidence.kind}`,
          resolved_at: now,
          retirement_kind: evidence.kind,
          retirement_receipt: retirementReceipt,
          retired_by: "system:stripe-customer-authority",
          retirement_reason: `provider lookup proved ${evidence.kind}`,
          retired_at: now,
          replacement_attempt_id: replacementId,
        })
        .where(eq(stripeCustomerLegacyQuarantines.organization_id, attempt.organization_id));
      const [cleared] = await tx
        .update(organizations)
        .set({ stripe_customer_id: null, updated_at: now })
        .where(
          and(
            eq(organizations.id, attempt.organization_id),
            eq(organizations.stripe_customer_id, evidence.customerId),
          ),
        )
        .returning({ id: organizations.id });
      if (!cleared) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_LEGACY_RETIREMENT_CAS_FAILED",
          "Legacy Stripe Customer clear compare-and-set failed",
        );
      }
    });
  }

  private async bind(claimed: ClaimedAttempt, candidate: StripeCustomerCandidate): Promise<string> {
    const matches = claimed.legacyCustomerId
      ? legacyCandidateMatches(claimed.attempt.organization_id, claimed.legacyCustomerId, candidate)
      : candidateMatches(claimed.attempt, candidate);
    if (!matches) {
      return this.quarantine(
        claimed.attempt.id,
        claimed.leaseToken,
        "provider metadata does not match tenant attempt authority",
      );
    }
    return writeTransaction(async (tx) => {
      const [organization] = await tx
        .select({ stripe_customer_id: organizations.stripe_customer_id })
        .from(organizations)
        .where(eq(organizations.id, claimed.attempt.organization_id))
        .for("update")
        .limit(1);
      const [attempt] = await tx
        .select()
        .from(stripeCustomerAttempts)
        .where(eq(stripeCustomerAttempts.id, claimed.attempt.id))
        .for("update")
        .limit(1);
      if (!organization || !attempt) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_BINDING_MISSING",
          "Stripe Customer binding authority disappeared",
        );
      }
      if (attempt.status === "bound") {
        if (attempt.provider_customer_id !== candidate.id) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_BINDING_CONFLICT",
            "Stripe Customer attempt is already bound to another provider object",
          );
        }
        return candidate.id;
      }
      if (attempt.lease_token !== claimed.leaseToken) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_LEASE_LOST",
          "Stripe Customer attempt lease changed before binding",
        );
      }
      if (organization.stripe_customer_id && organization.stripe_customer_id !== candidate.id) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_ORGANIZATION_CONFLICT",
          "Organization is already bound to another Stripe Customer",
        );
      }
      const receipt = {
        customer_id: candidate.id,
        created: candidate.created,
        livemode: candidate.livemode,
        binding_kind: claimed.legacyCustomerId ? "legacy_verified" : "attempt_created",
        metadata: claimed.legacyCustomerId
          ? { organization_id: attempt.organization_id }
          : authorityMetadata(attempt),
      };
      await tx
        .update(stripeCustomerAttempts)
        .set({
          status: "bound",
          provider_customer_id: candidate.id,
          provider_receipt: receipt,
          provider_livemode: candidate.livemode,
          bound_at: this.now(),
          lease_token: null,
          lease_expires_at: null,
          ambiguous_reason: null,
          updated_at: this.now(),
        })
        .where(eq(stripeCustomerAttempts.id, attempt.id));
      if (!organization.stripe_customer_id) {
        const [updated] = await tx
          .update(organizations)
          .set({ stripe_customer_id: candidate.id, updated_at: this.now() })
          .where(
            and(
              eq(organizations.id, claimed.attempt.organization_id),
              isNull(organizations.stripe_customer_id),
            ),
          )
          .returning({ id: organizations.id });
        if (!updated) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_CAS_FAILED",
            "Organization Stripe Customer compare-and-set failed",
          );
        }
      } else if (claimed.legacyCustomerId) {
        const [resolved] = await tx
          .update(stripeCustomerLegacyQuarantines)
          .set({
            resolved_attempt_id: attempt.id,
            resolved_by: "system:stripe-customer-authority",
            resolution_reason: "provider-verified legacy Customer tenant metadata",
            resolved_at: this.now(),
          })
          .where(
            and(
              eq(stripeCustomerLegacyQuarantines.organization_id, attempt.organization_id),
              eq(stripeCustomerLegacyQuarantines.stripe_customer_id, candidate.id),
              isNull(stripeCustomerLegacyQuarantines.resolved_attempt_id),
            ),
          )
          .returning({ organizationId: stripeCustomerLegacyQuarantines.organization_id });
        if (!resolved) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_LEGACY_CAS_FAILED",
            "Legacy Stripe Customer quarantine resolution compare-and-set failed",
          );
        }
      }
      return candidate.id;
    });
  }

  async ensure(input: {
    organizationId: string;
    callerIntent: StripeCustomerCallerIntent;
  }): Promise<string> {
    const deadline = Date.now() + (this.options.waitMs ?? DEFAULT_WAIT_MS);
    for (;;) {
      const claim = await this.claim(input.organizationId, input.callerIntent);
      if (claim.kind === "existing") return claim.customerId;
      if (claim.kind === "busy") {
        if (Date.now() >= deadline) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_ATTEMPT_BUSY",
            "Stripe Customer creation is already in progress",
            { organizationId: input.organizationId },
          );
        }
        await (this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          WAIT_STEP_MS,
        );
        continue;
      }

      let candidates: StripeCustomerCandidate[];
      try {
        if (claim.legacyCustomerId) {
          const lookup = await this.provider.retrieve(claim.legacyCustomerId);
          if (lookup.kind === "absent") {
            await this.retireLegacyCustomer(claim, {
              kind: lookup.reason,
              customerId: lookup.customerId,
            });
            continue;
          }
          const candidate = lookup.candidate;
          if (candidate.id !== claim.legacyCustomerId) {
            return this.quarantine(
              claim.attempt.id,
              claim.leaseToken,
              "provider returned a different Customer for exact legacy lookup",
            );
          }
          if (
            candidate.metadata.organization_id &&
            candidate.metadata.organization_id !== claim.attempt.organization_id
          ) {
            if (
              candidate.metadata.eliza_organization_id &&
              candidate.metadata.eliza_organization_id !== candidate.metadata.organization_id
            ) {
              return this.quarantine(
                claim.attempt.id,
                claim.leaseToken,
                "provider legacy Customer contains conflicting tenant metadata",
              );
            }
            await this.retireLegacyCustomer(claim, {
              kind: "wrong_tenant",
              customerId: candidate.id,
              providerOrganizationId: candidate.metadata.organization_id,
            });
            continue;
          }
          candidates = [candidate];
        } else {
          candidates = await this.provider.searchByAttemptId(claim.attempt.id);
        }
      } catch (error) {
        // error-policy:J2 Persist ambiguity before propagating the provider failure.
        await this.markAmbiguous(
          claim.attempt.id,
          claim.leaseToken,
          error instanceof Error ? error.message : "provider search failed",
        );
        throw error;
      }
      if (candidates.length > 1) {
        return this.quarantine(
          claim.attempt.id,
          claim.leaseToken,
          "multiple provider Customers match one attempt",
        );
      }
      if (candidates[0]) return this.bind(claim, candidates[0]);

      const startedAt = claim.attempt.provider_started_at ?? this.now();
      if (this.now().getTime() - startedAt.getTime() >= PROVIDER_REUSE_WINDOW_MS) {
        await this.markAmbiguous(
          claim.attempt.id,
          claim.leaseToken,
          "provider idempotency reuse window expired without a unique Customer",
        );
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_RECONCILIATION_REQUIRED",
          "Stripe Customer creation requires provider reconciliation",
          { attemptId: claim.attempt.id },
        );
      }

      const metadata = authorityMetadata(claim.attempt);
      try {
        const candidate = await this.provider.create(
          {
            name: claim.organizationName,
            ...(claim.billingEmail ? { email: claim.billingEmail } : {}),
            metadata,
          },
          claim.attempt.idempotency_key,
        );
        return await this.bind(claim, candidate);
      } catch (error) {
        // error-policy:J2 Persist create ambiguity before propagating the provider failure.
        await this.markAmbiguous(
          claim.attempt.id,
          claim.leaseToken,
          error instanceof Error ? error.message : "provider create result was ambiguous",
        );
        throw error;
      }
    }
  }

  async resolve(input: {
    organizationId: string;
    attemptId: string;
    actor: string;
    reason: string;
    action: "bind_unique_candidate" | "abandon_and_retry";
  }): Promise<{ customerId?: string; retryAttemptId?: string }> {
    if (!input.actor.trim() || !input.reason.trim()) {
      throw new StripeCustomerAuthorityError(
        "STRIPE_CUSTOMER_RESOLUTION_AUDIT_REQUIRED",
        "Stripe Customer resolution requires an actor and reason",
      );
    }
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    const leaseToken = randomUUID();
    const claim = await writeTransaction(async (tx) => {
      const now = this.now();
      const [organization] = await tx
        .select({
          id: organizations.id,
          name: organizations.name,
          billing_email: organizations.billing_email,
          stripe_customer_id: organizations.stripe_customer_id,
        })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .for("update")
        .limit(1);
      const [attempt] = await tx
        .select()
        .from(stripeCustomerAttempts)
        .where(eq(stripeCustomerAttempts.id, input.attemptId))
        .for("update")
        .limit(1);
      if (!organization || !attempt || attempt.organization_id !== organization.id) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_RESOLUTION_AUTHORITY_MISSING",
          "Stripe Customer resolution organization or attempt is missing",
        );
      }
      const [latest] = await tx
        .select({ id: stripeCustomerAttempts.id })
        .from(stripeCustomerAttempts)
        .where(eq(stripeCustomerAttempts.organization_id, organization.id))
        .orderBy(desc(stripeCustomerAttempts.generation))
        .limit(1);
      if (latest?.id !== attempt.id) {
        if (
          attempt.status === "abandoned" &&
          input.action === "abandon_and_retry" &&
          attempt.resolved_by === actor &&
          attempt.resolution_reason === reason
        ) {
          return {
            kind: "replay" as const,
            result: { retryAttemptId: latest?.id },
          };
        }
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_RESOLUTION_NOT_LATEST",
          "Only the latest Stripe Customer attempt can be resolved",
        );
      }
      if (attempt.status === "bound") {
        if (
          input.action !== "bind_unique_candidate" ||
          (attempt.resolved_by !== null &&
            (attempt.resolved_by !== actor || attempt.resolution_reason !== reason))
        ) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_RESOLUTION_REPLAY_CONFLICT",
            "Stripe Customer resolution replay does not match durable audit authority",
          );
        }
        return {
          kind: "replay" as const,
          result: { customerId: attempt.provider_customer_id ?? undefined },
        };
      }
      if (attempt.status !== "provider_ambiguous" && attempt.status !== "quarantined") {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_RESOLUTION_INVALID_STATE",
          "Stripe Customer attempt is not eligible for audited resolution",
          { status: attempt.status },
        );
      }
      if (
        attempt.lease_token &&
        attempt.lease_expires_at &&
        attempt.lease_expires_at.getTime() > now.getTime()
      ) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_RESOLUTION_BUSY",
          "Stripe Customer resolution is already in progress",
        );
      }
      const leaseExpiresAt = new Date(now.getTime() + (this.options.leaseMs ?? DEFAULT_LEASE_MS));
      const [leased] = await tx
        .update(stripeCustomerAttempts)
        .set({ lease_token: leaseToken, lease_expires_at: leaseExpiresAt, updated_at: now })
        .where(eq(stripeCustomerAttempts.id, attempt.id))
        .returning();
      if (!leased) {
        throw new StripeCustomerAuthorityError(
          "STRIPE_CUSTOMER_RESOLUTION_LEASE_RACE",
          "Stripe Customer resolution lease could not be acquired",
        );
      }
      return { kind: "claimed" as const, attempt: leased };
    });
    if (claim.kind === "replay") return claim.result;

    let candidates: StripeCustomerCandidate[];
    try {
      candidates = (await this.provider.searchByAttemptId(claim.attempt.id)).filter((candidate) =>
        candidateMatches(claim.attempt, candidate),
      );
    } catch (error) {
      // error-policy:J2 Release the resolution fence before propagating provider search failure.
      await this.releaseResolutionLease(
        claim.attempt.id,
        leaseToken,
        error instanceof Error ? error.message : "provider search failed during resolution",
      );
      throw error;
    }

    try {
      return await writeTransaction(async (tx) => {
        const now = this.now();
        const [organization] = await tx
          .select({
            id: organizations.id,
            name: organizations.name,
            billing_email: organizations.billing_email,
            stripe_customer_id: organizations.stripe_customer_id,
          })
          .from(organizations)
          .where(eq(organizations.id, input.organizationId))
          .for("update")
          .limit(1);
        const [attempt] = await tx
          .select()
          .from(stripeCustomerAttempts)
          .where(eq(stripeCustomerAttempts.id, input.attemptId))
          .for("update")
          .limit(1);
        if (
          !organization ||
          !attempt ||
          attempt.organization_id !== organization.id ||
          attempt.lease_token !== leaseToken
        ) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_RESOLUTION_LEASE_LOST",
            "Stripe Customer resolution authority changed during provider lookup",
          );
        }
        const [latest] = await tx
          .select({ id: stripeCustomerAttempts.id })
          .from(stripeCustomerAttempts)
          .where(eq(stripeCustomerAttempts.organization_id, organization.id))
          .orderBy(desc(stripeCustomerAttempts.generation))
          .limit(1);
        if (latest?.id !== attempt.id) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_RESOLUTION_NOT_LATEST",
            "Only the latest Stripe Customer attempt can be resolved",
          );
        }
        if (candidates.length > 1) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_RESOLUTION_DUPLICATE",
            "Audited resolution found multiple verified Stripe Customers",
          );
        }
        if (input.action === "bind_unique_candidate") {
          const candidate = candidates[0];
          if (!candidate) {
            throw new StripeCustomerAuthorityError(
              "STRIPE_CUSTOMER_RESOLUTION_NO_CANDIDATE",
              "Audited binding requires exactly one verified Stripe Customer",
            );
          }
          if (organization.stripe_customer_id && organization.stripe_customer_id !== candidate.id) {
            throw new StripeCustomerAuthorityError(
              "STRIPE_CUSTOMER_ORGANIZATION_CONFLICT",
              "Organization is already bound to another Stripe Customer",
            );
          }
          const receipt = {
            customer_id: candidate.id,
            created: candidate.created,
            livemode: candidate.livemode,
            binding_kind: "attempt_created",
            metadata: authorityMetadata(attempt),
          };
          await tx
            .update(stripeCustomerAttempts)
            .set({
              status: "bound",
              provider_customer_id: candidate.id,
              provider_receipt: receipt,
              provider_livemode: candidate.livemode,
              bound_at: now,
              lease_token: null,
              lease_expires_at: null,
              ambiguous_reason: null,
              resolved_by: actor,
              resolution_reason: reason,
              resolved_at: now,
              updated_at: now,
            })
            .where(eq(stripeCustomerAttempts.id, attempt.id));
          if (!organization.stripe_customer_id) {
            const [updated] = await tx
              .update(organizations)
              .set({ stripe_customer_id: candidate.id, updated_at: now })
              .where(
                and(
                  eq(organizations.id, organization.id),
                  isNull(organizations.stripe_customer_id),
                ),
              )
              .returning({ id: organizations.id });
            if (!updated) {
              throw new StripeCustomerAuthorityError(
                "STRIPE_CUSTOMER_CAS_FAILED",
                "Organization Stripe Customer compare-and-set failed during resolution",
              );
            }
          }
          return { customerId: candidate.id };
        }
        if (candidates[0]) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_RESOLUTION_CANDIDATE_EXISTS",
            "A verified Stripe Customer must be bound instead of abandoned",
          );
        }
        if (
          !attempt.provider_started_at ||
          now.getTime() - attempt.provider_started_at.getTime() < PROVIDER_REUSE_WINDOW_MS
        ) {
          throw new StripeCustomerAuthorityError(
            "STRIPE_CUSTOMER_RESOLUTION_WINDOW_ACTIVE",
            "Stripe provider recovery window has not expired",
          );
        }
        await tx
          .update(stripeCustomerAttempts)
          .set({
            status: "abandoned",
            lease_token: null,
            lease_expires_at: null,
            resolved_by: actor,
            resolution_reason: reason,
            resolved_at: now,
            updated_at: now,
          })
          .where(eq(stripeCustomerAttempts.id, attempt.id));
        const generation = attempt.generation + 1;
        const id = randomUUID();
        const digest = requestDigest({
          organizationId: organization.id,
          generation,
          organizationName: organization.name,
          billingEmail: organization.billing_email,
        });
        await tx.insert(stripeCustomerAttempts).values({
          id,
          organization_id: organization.id,
          generation,
          request_digest: digest,
          caller_intent: attempt.caller_intent,
          idempotency_key: `eliza-customer-attempt:${id}`,
          status: "prepared",
        });
        return { retryAttemptId: id };
      });
    } catch (error) {
      // error-policy:J2 Release the resolution fence before propagating commit failure.
      await this.releaseResolutionLease(
        claim.attempt.id,
        leaseToken,
        error instanceof Error ? error.message : "resolution commit failed",
      );
      throw error;
    }
  }
}

export const stripeCustomerAuthorityService = new StripeCustomerAuthorityService();
