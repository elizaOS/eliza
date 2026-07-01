/**
 * Influencer marketing marketplace service (#10687).
 *
 * Two-sided booking with escrow over existing rails: advertiser org credits are
 * debited when an offer is funded, released to the influencer's redeemable
 * earnings on approval, or refunded on rejection/cancel. Every money move is
 * gated by an atomic status transition (a CAS `UPDATE ... WHERE status = <from>
 * RETURNING`), so a retry / concurrent call moves money exactly once.
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
   * Fund an offer: debit the advertiser's org credits (the escrow), then record
   * the booking. If the debit fails (insufficient credits) no booking is made.
   */
  async createBooking(input: {
    advertiserOrgId: string;
    profileId: string;
    brief: string;
    amount: number;
    createdByUserId: string;
  }): Promise<BookingResult> {
    if (input.amount <= 0) return { ok: false, error: "Amount must be positive" };
    const profile = await this.getProfile(input.profileId);
    if (!profile || profile.status !== "active") {
      return { ok: false, error: "Influencer profile not available" };
    }
    if (profile.organization_id === input.advertiserOrgId) {
      return { ok: false, error: "Cannot book your own profile" };
    }

    const debit = await creditsService.deductCredits({
      organizationId: input.advertiserOrgId,
      amount: input.amount,
      description: `Influencer booking escrow (${profile.display_name})`,
      metadata: { kind: "influencer_escrow", profileId: input.profileId },
    });
    if (!debit.success) {
      return { ok: false, error: debit.reason ?? "Insufficient credits" };
    }

    const [booking] = await dbWrite
      .insert(influencerBookings)
      .values({
        advertiser_org_id: input.advertiserOrgId,
        influencer_profile_id: input.profileId,
        influencer_user_id: profile.user_id,
        brief: input.brief,
        amount: input.amount.toFixed(2),
        status: "offered",
        created_by_user_id: input.createdByUserId,
      })
      .returning();
    return { ok: true, booking };
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

  /** Advertiser approves the deliverable → release escrow to the influencer. */
  async approveBooking(id: string, advertiserOrgId: string): Promise<BookingResult> {
    const booking = await this.getBooking(id);
    if (!booking || booking.advertiser_org_id !== advertiserOrgId) {
      return { ok: false, error: "Booking not found" };
    }
    // CAS gate: only a `delivered` booking can be approved (moves money once).
    const moved = await this.transition(id, "delivered", "approved", { resolved_at: new Date() });
    if (!moved) return { ok: false, error: "Not awaiting approval" };

    // Release escrow to the influencer (idempotent on the booking id).
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
      logger.error("[Influencer] payout failed after approval", {
        bookingId: id,
        error: credit.error,
      });
    }
    return { ok: true, booking: moved };
  }

  /** Refund the advertiser (deliverable rejected, influencer declined, or cancel). */
  private async refund(
    id: string,
    from: InfluencerBookingStatus,
    to: InfluencerBookingStatus,
  ): Promise<BookingResult> {
    const booking = await this.getBooking(id);
    if (!booking) return { ok: false, error: "Booking not found" };
    const moved = await this.transition(id, from, to, { resolved_at: new Date() });
    if (!moved) return { ok: false, error: "Not in a refundable state" };

    // Idempotent refund (unique on stripe_payment_intent_id backstop).
    await creditsService.refundCredits({
      organizationId: booking.advertiser_org_id,
      amount: Number(booking.amount),
      description: "Influencer booking refund",
      stripePaymentIntentId: `influencer_refund_${id}`,
      metadata: { kind: "influencer_refund", bookingId: id },
    });
    return { ok: true, booking: moved };
  }

  rejectBooking(id: string, influencerUserId: string): Promise<BookingResult> {
    return this.getBooking(id).then((b) =>
      !b || b.influencer_user_id !== influencerUserId
        ? { ok: false, error: "Booking not found" }
        : this.refund(id, "offered", "rejected"),
    );
  }

  rejectDeliverable(id: string, advertiserOrgId: string): Promise<BookingResult> {
    return this.getBooking(id).then((b) =>
      !b || b.advertiser_org_id !== advertiserOrgId
        ? { ok: false, error: "Booking not found" }
        : this.refund(id, "delivered", "rejected"),
    );
  }

  cancelBooking(id: string, advertiserOrgId: string): Promise<BookingResult> {
    return this.getBooking(id).then((b) =>
      !b || b.advertiser_org_id !== advertiserOrgId
        ? { ok: false, error: "Booking not found" }
        : this.refund(id, "offered", "cancelled"),
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
