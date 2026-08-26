/**
 * Ledger-backed billing session for cloud-hosted meeting transcription.
 *
 * The meetings plugin owns bot orchestration and ASR, but cloud deployments need
 * a money boundary that can reserve a small launch window, extend in bounded
 * chunks as audio reaches transcription, and reconcile every hold exactly once
 * when the meeting exits. This module stays in cloud-shared so the generic
 * plugin does not import server-only database services.
 */

import { ElizaError } from "@elizaos/core/edge";
import type { MeetingBillingState, MeetingEndReason } from "@elizaos/shared";
import { type CreditReservation, creditsService, InsufficientCreditsError } from "./credits";

export type MeetingCloudBillingErrorCode = "insufficient_credits" | "billing_failed";

export class MeetingCloudBillingError extends Error {
  constructor(
    readonly code: MeetingCloudBillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MeetingCloudBillingError";
  }
}

export interface MeetingCreditBillingSessionOptions {
  organizationId: string;
  userId?: string;
  sessionId: string;
  meetingUrl?: string;
  maxDurationMs: number;
  usdPerMinute?: number;
  initialWindowMs?: number;
  chunkWindowMs?: number;
}

interface HeldReservation {
  reservation: CreditReservation;
  reservedMs: number;
}

const DEFAULT_USD_PER_MINUTE = 0.006;
const DEFAULT_INITIAL_WINDOW_MS = 60_000;
const DEFAULT_CHUNK_WINDOW_MS = 60_000;

function readPositiveNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveMeetingUsdPerMinute(env: Record<string, string | undefined> = process.env) {
  const raw = env.ELIZA_MEETINGS_TRANSCRIPTION_USD_PER_MINUTE;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_USD_PER_MINUTE;
  }
  // A present-but-invalid override must throw, not silently bill at the
  // default rate — a typo'd price would otherwise go unnoticed while every
  // meeting is charged the wrong amount.
  const parsed = readPositiveNumber(raw);
  if (parsed === null) {
    throw new ElizaError(
      "ELIZA_MEETINGS_TRANSCRIPTION_USD_PER_MINUTE must be a positive, finite number",
      {
        code: "INVALID_MEETING_USD_PER_MINUTE",
        context: { configured: raw },
        severity: "fatal",
      },
    );
  }
  return parsed;
}

function dollarsForMs(ms: number, usdPerMinute: number): number {
  return (ms / 60_000) * usdPerMinute;
}

function chunkMs(requestedMs: number, chunkWindowMs: number): number {
  return Math.max(chunkWindowMs, requestedMs);
}

/**
 * Credit-backed meeting billing state.
 *
 * Each extension creates an ordinary credit reservation debit. Reconciliation
 * settles those reservations in order, charging only the consumed milliseconds
 * and refunding any unused tail of the last chunk. The first reconcile caller
 * wins so adapter returns, abort handlers, and cleanup paths can all safely call
 * it for the same session.
 */
export class MeetingCreditBillingSession {
  readonly state: MeetingBillingState = {
    status: "reserved",
    reservedMs: 0,
    consumedMs: 0,
    reservationIds: [],
  };

  private readonly organizationId: string;
  private readonly userId?: string;
  private readonly sessionId: string;
  private readonly meetingUrl?: string;
  private readonly maxDurationMs: number;
  private readonly usdPerMinute: number;
  private readonly initialWindowMs: number;
  private readonly chunkWindowMs: number;
  private readonly holds: HeldReservation[] = [];
  private reconcilePromise: Promise<MeetingBillingState> | null = null;

  constructor(options: MeetingCreditBillingSessionOptions) {
    // Money inputs must be finite and positive up front. A NaN maxDurationMs
    // disables the spend cap (`nextConsumedMs > NaN` is false) and a NaN or
    // negative rate/window flows into reservation amounts, so a malformed
    // option must fail here rather than at settlement time.
    for (const [option, value, required] of [
      ["maxDurationMs", options.maxDurationMs, true],
      ["usdPerMinute", options.usdPerMinute, false],
      ["initialWindowMs", options.initialWindowMs, false],
      ["chunkWindowMs", options.chunkWindowMs, false],
    ] as const) {
      if (value === undefined ? required : !Number.isFinite(value) || value <= 0) {
        throw new ElizaError(
          `MeetingCreditBillingSession ${option} must be a positive, finite number`,
          {
            code: "INVALID_MEETING_BILLING_OPTION",
            context: { option, value, sessionId: options.sessionId },
            severity: "fatal",
          },
        );
      }
    }
    this.organizationId = options.organizationId;
    this.userId = options.userId;
    this.sessionId = options.sessionId;
    this.meetingUrl = options.meetingUrl;
    this.maxDurationMs = options.maxDurationMs;
    this.usdPerMinute = options.usdPerMinute ?? resolveMeetingUsdPerMinute();
    this.initialWindowMs = options.initialWindowMs ?? DEFAULT_INITIAL_WINDOW_MS;
    this.chunkWindowMs = options.chunkWindowMs ?? DEFAULT_CHUNK_WINDOW_MS;
    this.state.capMs = options.maxDurationMs;
  }

  async reserveInitial(): Promise<void> {
    await this.reserveWindow(Math.min(this.initialWindowMs, this.maxDurationMs));
  }

  async ensureTranscriptionWindow(durationMs: number): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const nextConsumedMs = this.state.consumedMs + Math.ceil(durationMs);
    if (nextConsumedMs > this.maxDurationMs) {
      this.state.status = "spend_cap_reached";
      this.state.error = "meeting transcription spend cap reached";
      throw new MeetingCloudBillingError("insufficient_credits", this.state.error);
    }

    const neededMs = nextConsumedMs - this.state.reservedMs;
    if (neededMs > 0) {
      await this.reserveWindow(
        Math.min(chunkMs(neededMs, this.chunkWindowMs), this.maxDurationMs - this.state.reservedMs),
      );
    }
    this.state.consumedMs = nextConsumedMs;
  }

  async reconcile(reason: MeetingEndReason): Promise<MeetingBillingState> {
    if (!this.reconcilePromise) {
      this.reconcilePromise = this.reconcileOnce(reason);
    }
    return await this.reconcilePromise;
  }

  private async reserveWindow(windowMs: number): Promise<void> {
    if (windowMs <= 0) return;
    try {
      const reservation = await creditsService.reserve({
        organizationId: this.organizationId,
        userId: this.userId,
        amount: dollarsForMs(windowMs, this.usdPerMinute),
        description: `Meeting transcription ${this.sessionId}`,
      });
      this.holds.push({ reservation, reservedMs: windowMs });
      this.state.reservedMs += windowMs;
      if (reservation.reservationTransactionId) {
        this.state.reservationIds?.push(reservation.reservationTransactionId);
      }
      this.state.status = "reserved";
    } catch (error) {
      this.state.status = "spend_cap_reached";
      this.state.error = error instanceof Error ? error.message : String(error);
      if (error instanceof InsufficientCreditsError) {
        throw new MeetingCloudBillingError("insufficient_credits", error.message);
      }
      throw new MeetingCloudBillingError("billing_failed", this.state.error);
    }
  }

  private async reconcileOnce(reason: MeetingEndReason): Promise<MeetingBillingState> {
    let remainingConsumedMs = this.state.consumedMs;
    for (const hold of this.holds) {
      const billedMs = Math.min(remainingConsumedMs, hold.reservedMs);
      remainingConsumedMs = Math.max(0, remainingConsumedMs - billedMs);
      await hold.reservation.reconcile(dollarsForMs(billedMs, this.usdPerMinute));
    }
    this.state.status = "reconciled";
    this.state.error =
      reason === "ended_due_to_spend_cap" ? "meeting transcription spend cap reached" : undefined;
    return {
      ...this.state,
      reservationIds: [...(this.state.reservationIds ?? [])],
    };
  }
}

export function createMeetingCreditBillingSession(options: MeetingCreditBillingSessionOptions) {
  return new MeetingCreditBillingSession(options);
}
