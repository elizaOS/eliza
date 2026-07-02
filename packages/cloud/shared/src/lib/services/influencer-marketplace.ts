/**
 * Influencer marketing marketplace service (#10687).
 *
 * Two-sided booking with escrow over existing rails: advertiser org credits are
 * debited when an offer is funded, released to the influencer's redeemable
 * earnings on approval, or refunded on rejection/cancel. Every money move is
 * idempotent on the booking id (keyed debit / dedupe-by-source payout / keyed
 * refund) and runs BEFORE the status finalize (an atomic CAS
 * `UPDATE ... WHERE status = <from> RETURNING`), so a crash or retry moves
 * money at most once and never finalizes a status the money didn't reach.
 */

import { and, desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/helpers";
import {
  type InfluencerBooking,
  type InfluencerBookingStatus,
  type InfluencerPlatform,
  type InfluencerProfile,
  influencerBookings,
  influencerProfiles,
} from "../../db/schemas/influencer-marketplace";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";
import { redeemableEarningsService } from "./redeemable-earnings";

export interface BookingResult {
  ok: boolean;
  booking?: InfluencerBooking;
  error?: string;
}

export class InfluencerMarketplaceService {
  // ---- profiles ----

  createProfile(input: {
    userId: string;
    organizationId: string;
    displayName: string;
    niche?: string;
    bio?: string;
    platforms?: InfluencerPlatform[];
    rateCard?: Record<string, unknown>;
  }): Promise<InfluencerProfile> {
    return dbWrite
      .insert(influencerProfiles)
      .values({
        user_id: input.userId,
        organization_id: input.organizationId,
        display_name: input.displayName,
        niche: input.niche ?? null,
        bio: input.bio ?? null,
        platforms: input.platforms ?? [],
        rate_card: input.rateCard ?? {},
      })
      .returning()
      .then((r) => r[0]);
  }

  getProfile(id: string): Promise<InfluencerProfile | undefined> {
    return dbRead.query.influencerProfiles.findFirst({
      where: eq(influencerProfiles.id, id),
    });
  }

  /** Browse active profiles, optionally filtered by niche (advertiser discovery). */
  async listProfiles(opts: { niche?: string; limit?: number } = {}): Promise<InfluencerProfile[]> {
    const where = opts.niche
      ? and(eq(influencerProfiles.status, "active"), eq(influencerProfiles.niche, opts.niche))
      : eq(influencerProfiles.status, "active");
    return dbRead.query.influencerProfiles.findMany({
      where,
      orderBy: [desc(influencerProfiles.created_at)],
      limit: opts.limit ?? 100,
    });
  }

  listMyProfiles(organizationId: string): Promise<InfluencerProfile[]> {
    return dbRead.query.influencerProfiles.findMany({
      where: eq(influencerProfiles.organization_id, organizationId),
      orderBy: [desc(influencerProfiles.created_at)],
    });
  }

  async updateProfile(
    id: string,
    patch: Partial<Pick<InfluencerProfile, "display_name" | "niche" | "bio" | "status">> & {
      platforms?: InfluencerPlatform[];
      rateCard?: Record<string, unknown>;
    },
  ): Promise<InfluencerProfile | undefined> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.display_name !== undefined) set.display_name = patch.display_name;
    if (patch.niche !== undefined) set.niche = patch.niche;
    if (patch.bio !== undefined) set.bio = patch.bio;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.platforms !== undefined) set.platforms = patch.platforms;
    if (patch.rateCard !== undefined) set.rate_card = patch.rateCard;
    const [row] = await dbWrite
      .update(influencerProfiles)
      .set(set)
      .where(eq(influencerProfiles.id, id))
      .returning();
    return row;
  }

  // ---- bookings (escrow) ----

  getBooking(id: string): Promise<InfluencerBooking | undefined> {
    return dbRead.query.influencerBookings.findFirst({
      where: eq(influencerBookings.id, id),
    });
  }

  /**
   * Fund an offer — booking row first, money second, finalize last:
   *
   *   1. insert the booking in status `funding` (no money moved yet),
   *   2. debit the advertiser's org credits keyed on `influencer_fund_<id>`
   *      (idempotent — a retry can never debit twice for one booking),
   *   3. CAS `funding` → `offered`, recording the escrow transaction id.
   *
   * A crash between steps leaves a `funding` row plus at most one keyed debit —
   * never a debit without a booking row to reconcile. A client retry with the
   * same `idempotencyKey` resumes the original booking instead of funding a
   * second one.
   */
  async createBooking(input: {
    advertiserOrgId: string;
    profileId: string;
    brief: string;
    amount: number;
    createdByUserId: string;
    idempotencyKey?: string;
  }): Promise<BookingResult> {
    if (input.amount <= 0) return { ok: false, error: "Amount must be positive" };
    const profile = await this.getProfile(input.profileId);
    if (!profile || profile.status !== "active") {
      return { ok: false, error: "Influencer profile not available" };
    }
    if (profile.organization_id === input.advertiserOrgId) {
      return { ok: false, error: "Cannot book your own profile" };
    }

    if (input.idempotencyKey) {
      const existing = await dbRead.query.influencerBookings.findFirst({
        where: eq(influencerBookings.idempotency_key, input.idempotencyKey),
      });
      if (existing) {
        if (existing.advertiser_org_id !== input.advertiserOrgId) {
          return { ok: false, error: "Idempotency key already used" };
        }
        return this.fundBooking(existing, profile.display_name);
      }
    }

    const inserted = await dbWrite
      .insert(influencerBookings)
      .values({
        advertiser_org_id: input.advertiserOrgId,
        influencer_profile_id: input.profileId,
        influencer_user_id: profile.user_id,
        brief: input.brief,
        amount: input.amount.toFixed(2),
        status: "funding",
        created_by_user_id: input.createdByUserId,
        idempotency_key: input.idempotencyKey ?? null,
      })
      .onConflictDoNothing({ target: influencerBookings.idempotency_key })
      .returning();

    let booking = inserted[0];
    if (!booking) {
      // Lost a concurrent same-key create; resume the winner's booking.
      const winner = input.idempotencyKey
        ? await dbRead.query.influencerBookings.findFirst({
            where: eq(influencerBookings.idempotency_key, input.idempotencyKey),
          })
        : undefined;
      if (!winner) return { ok: false, error: "Booking insert failed" };
      booking = winner;
    }
    return this.fundBooking(booking, profile.display_name);
  }

  /**
   * Drive a booking from `funding` to `offered`: keyed escrow debit, then the
   * finalize CAS. Safe to call repeatedly — a booking already past `funding`
   * returns as-is, and a retry after a crashed funding attempt debits nothing
   * new (the debit is idempotent on `influencer_fund_<bookingId>`).
   */
  private async fundBooking(
    booking: InfluencerBooking,
    displayName: string,
  ): Promise<BookingResult> {
    if (booking.status !== "funding") return { ok: true, booking };

    const debit = await creditsService.deductCredits({
      organizationId: booking.advertiser_org_id,
      amount: Number(booking.amount),
      description: `Influencer booking escrow (${displayName})`,
      metadata: {
        kind: "influencer_escrow",
        profileId: booking.influencer_profile_id,
        bookingId: booking.id,
      },
      stripePaymentIntentId: `influencer_fund_${booking.id}`,
    });
    if (!debit.success) {
      // No money moved — retire the unfunded intent row so a retry starts clean.
      await dbWrite
        .delete(influencerBookings)
        .where(
          and(eq(influencerBookings.id, booking.id), eq(influencerBookings.status, "funding")),
        );
      return { ok: false, error: debit.reason ?? "Insufficient credits" };
    }

    const moved = await this.transition(booking.id, "funding", "offered", {
      escrow_transaction_id: debit.transaction?.id ?? null,
    });
    if (moved) return { ok: true, booking: moved };
    // A concurrent resume finalized it first.
    const current = await this.getBooking(booking.id);
    return current && current.status !== "funding"
      ? { ok: true, booking: current }
      : { ok: false, error: "Funding could not be finalized" };
  }

  /**
   * Atomic status CAS — the money-safety gate. Returns the row iff it moved from
   * `from` → `to`; a retry / concurrent call finds a different status, matches 0
   * rows, and returns undefined (so the caller moves no money twice).
   */
  private async transition(
    id: string,
    from: InfluencerBookingStatus,
    to: InfluencerBookingStatus,
    extra: Record<string, unknown> = {},
  ): Promise<InfluencerBooking | undefined> {
    const [row] = await dbWrite
      .update(influencerBookings)
      .set({ status: to, updated_at: new Date(), ...extra })
      .where(and(eq(influencerBookings.id, id), eq(influencerBookings.status, from)))
      .returning();
    return row;
  }

  async acceptBooking(id: string, influencerUserId: string): Promise<BookingResult> {
    const booking = await this.getBooking(id);
    if (!booking || booking.influencer_user_id !== influencerUserId) {
      return { ok: false, error: "Booking not found" };
    }
    const moved = await this.transition(id, "offered", "accepted");
    return moved
      ? { ok: true, booking: moved }
      : { ok: false, error: "Not in an acceptable state" };
  }

  async submitDeliverable(
    id: string,
    influencerUserId: string,
    deliverableUrl: string,
  ): Promise<BookingResult> {
    const booking = await this.getBooking(id);
    if (!booking || booking.influencer_user_id !== influencerUserId) {
      return { ok: false, error: "Booking not found" };
    }
    const moved = await this.transition(id, "accepted", "delivered", {
      deliverable_url: deliverableUrl,
    });
    return moved
      ? { ok: true, booking: moved }
      : { ok: false, error: "Not awaiting a deliverable" };
  }

  /**
   * Advertiser approves the deliverable → release escrow to the influencer.
   *
   * Pay-then-finalize: the payout runs BEFORE the status move. The payout is
   * idempotent on the booking id, so a crash/retry pays at most once, and a
   * payout failure leaves the booking `delivered` so approval can be retried —
   * this can never mark a booking approved without the influencer being paid.
   */
  async approveBooking(id: string, advertiserOrgId: string): Promise<BookingResult> {
    const booking = await this.getBooking(id);
    if (!booking || booking.advertiser_org_id !== advertiserOrgId) {
      return { ok: false, error: "Booking not found" };
    }

    // Claim the `delivered` money fork before paying (#11116). Exactly one of
    // {approve, rejectDeliverable} can win the atomic CAS `delivered → approving`;
    // the loser matches 0 rows and moves no money. A booking already `approving`
    // is a resume (a prior attempt claimed but hadn't finished paying) — the
    // payout is idempotent, so re-running is safe. Any other status = not ours.
    if (booking.status === "delivered") {
      const claimed = await this.transition(id, "delivered", "approving");
      if (!claimed) {
        // Lost the fork to a concurrent reject (or another approve) — re-read
        // and only continue if WE still own an `approving` claim.
        const current = await this.getBooking(id);
        if (current?.status !== "approving") {
          return { ok: false, error: "Not awaiting approval" };
        }
      }
    } else if (booking.status !== "approving") {
      return { ok: false, error: "Not awaiting approval" };
    }

    const credit = await redeemableEarningsService.addEarnings({
      userId: booking.influencer_user_id,
      amount: Number(booking.amount),
      source: "creator_revenue_share",
      sourceId: `influencer_booking_${id}`,
      dedupeBySourceId: true,
      description: "Influencer booking payout",
      metadata: { kind: "influencer_payout", bookingId: id, advertiserOrgId },
    });
    if (!credit.success) {
      logger.error("[Influencer] payout failed; booking left approving for retry", {
        bookingId: id,
        error: credit.error,
      });
      return { ok: false, error: "Payout failed — retry approval" };
    }

    const moved = await this.transition(id, "approving", "approved", { resolved_at: new Date() });
    if (moved) return { ok: true, booking: moved };

    const current = await this.getBooking(id);
    if (current?.status === "approved") return { ok: true, booking: current };
    logger.error("[Influencer] payout committed but booking moved off approving", {
      bookingId: id,
      status: current?.status,
    });
    return { ok: false, error: "Not awaiting approval" };
  }

  /**
   * Refund the advertiser — every refund leg: influencer declines an offered/
   * accepted booking, advertiser rejects a delivered deliverable (#11116), or
   * advertiser cancels an un-accepted offer.
   *
   * Claim-then-refund (#11116, #11167): every refund races a payout — the
   * `delivered` fork directly against approveBooking, and the offer/accept
   * legs because `accepted` is one hop from the payable `delivered` state —
   * so a refund that moves money before claiming the booking can collide with
   * a concurrent deliver + approve and pay one escrow out twice. The refund
   * therefore first CLAIMS the booking with an atomic CAS `<from> → refunding`
   * — once claimed, no other transition can enter (accept needs `offered`,
   * submitDeliverable needs `accepted`, approve needs `delivered`/`approving`)
   * — and only then moves money. The refund is idempotent on the booking id
   * (one refund per booking, ever) and a refund failure leaves the booking
   * `refunding` so the operation can be resumed; a booking found already
   * `refunding` is admitted as that resume. Each caller finalizes with its own
   * terminal (`rejected`/`cancelled`), so a resume through the other route
   * only relabels an already-committed refund — money never moves twice, and
   * a booking is never marked terminal while the advertiser is still debited.
   */
  private async refund(
    id: string,
    allowedFrom: InfluencerBookingStatus[],
    to: InfluencerBookingStatus,
  ): Promise<BookingResult> {
    const booking = await this.getBooking(id);
    if (!booking) return { ok: false, error: "Booking not found" };

    if (allowedFrom.includes(booking.status)) {
      const claimed = await this.transition(id, booking.status, "refunding");
      if (!claimed) {
        // Lost the claim to a concurrent transition — re-read and continue
        // only if a refund claim (concurrent or crashed) owns the booking.
        const current = await this.getBooking(id);
        if (current?.status !== "refunding") {
          return { ok: false, error: "Not in a refundable state" };
        }
      }
    } else if (booking.status !== "refunding") {
      // `refunding` is a resume (a prior attempt claimed but hadn't finished
      // refunding); anything else is not ours to refund.
      return { ok: false, error: "Not in a refundable state" };
    }

    try {
      await creditsService.refundCredits({
        organizationId: booking.advertiser_org_id,
        amount: Number(booking.amount),
        description: "Influencer booking refund",
        stripePaymentIntentId: `influencer_refund_${id}`,
        metadata: { kind: "influencer_refund", bookingId: id },
      });
    } catch (error) {
      logger.error("[Influencer] escrow refund failed; booking left refunding for retry", {
        bookingId: id,
        to,
        error,
      });
      return { ok: false, error: "Refund failed — retry" };
    }

    const moved = await this.transition(id, "refunding", to, { resolved_at: new Date() });
    if (moved) return { ok: true, booking: moved };

    // The refund is committed, so the booking MUST already be in a refunded
    // state: once the claim is won nothing but a concurrent resume of this
    // refund can move the booking.
    const current = await this.getBooking(id);
    if (current && (current.status === "rejected" || current.status === "cancelled")) {
      return { ok: true, booking: current }; // a concurrent resume finalized first
    }
    logger.error("[Influencer] refund committed but booking moved off refunding", {
      bookingId: id,
      status: current?.status,
      to,
    });
    return { ok: false, error: "Booking changed state during refund" };
  }

  /** Influencer declines: from `offered` (never accepted) or `accepted` (backing out). */
  rejectBooking(id: string, influencerUserId: string): Promise<BookingResult> {
    return this.getBooking(id).then((b) =>
      !b || b.influencer_user_id !== influencerUserId
        ? { ok: false, error: "Booking not found" }
        : this.refund(id, ["offered", "accepted"], "rejected"),
    );
  }

  /** Advertiser rejects a submitted deliverable — the refund side of the `delivered` money fork (#11116), racing `approveBooking` for the same escrow. */
  rejectDeliverable(id: string, advertiserOrgId: string): Promise<BookingResult> {
    return this.getBooking(id).then((b) =>
      !b || b.advertiser_org_id !== advertiserOrgId
        ? { ok: false, error: "Booking not found" }
        : this.refund(id, ["delivered"], "rejected"),
    );
  }

  cancelBooking(id: string, advertiserOrgId: string): Promise<BookingResult> {
    return this.getBooking(id).then((b) =>
      !b || b.advertiser_org_id !== advertiserOrgId
        ? { ok: false, error: "Booking not found" }
        : this.refund(id, ["offered"], "cancelled"),
    );
  }

  listBookingsForOrg(organizationId: string): Promise<InfluencerBooking[]> {
    return dbRead.query.influencerBookings.findMany({
      where: eq(influencerBookings.advertiser_org_id, organizationId),
      orderBy: [desc(influencerBookings.created_at)],
    });
  }

  listBookingsForInfluencer(influencerUserId: string): Promise<InfluencerBooking[]> {
    return dbRead.query.influencerBookings.findMany({
      where: eq(influencerBookings.influencer_user_id, influencerUserId),
      orderBy: [desc(influencerBookings.created_at)],
    });
  }
}

export const influencerMarketplaceService = new InfluencerMarketplaceService();
