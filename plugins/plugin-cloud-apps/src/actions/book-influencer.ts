/**
 * BOOK_INFLUENCER (#10687) — the agent hires an influencer to promote, with a
 * two-phase money confirm.
 *
 *   1. First ask NEVER moves money: it resolves the influencer + amount + brief,
 *      persists a pending confirmation (safety.ts), and asks the user to confirm.
 *   2. On a later turn carrying the planner's structured `confirm: true` for that
 *      pending prompt, it funds the escrowed booking via `client.createBooking`
 *      (the advertiser's own org credits are debited into escrow; released to the
 *      influencer on approval, refunded on rejection — no external keys).
 *
 * Guardrails shared with the other gated actions:
 *   - at most ONE pending booking per room (a fresh pending re-prompts; a stale
 *     one is replaced), and a pending older than CONFIRM_TTL_MS refuses the
 *     bare confirm (safety.ts),
 *   - a budget needs an explicit currency cue — a bare number in the message is
 *     never treated as dollars,
 *   - influencer names resolve through the ambiguity-aware matcher (client.ts);
 *     ties ask the user instead of booking a lookalike profile,
 *   - the pending is deleted only AFTER the fund call resolves (#11844): its
 *     taskId is the sole holder of the escrow idempotency key
 *     (`influencer-confirm-<taskId>`), so on a transport-level failure the
 *     pending is kept and marked `recovery: true` — a re-confirm re-sends the
 *     SAME key and the server resumes/dedupes the exact booking (its funding
 *     resume) instead of funding a second escrow.
 */

import type { InfluencerProfileDto } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger, unwrapUserMessageText } from "@elizaos/core";
import {
  appReferenceLogView,
  describeAppReference,
  getCloudClient,
  matchByReference,
  type ReferenceMatch,
  resolveCloudApiKey,
  resolveCloudSiteBaseUrl,
} from "../client.js";
import { cloudErrorInfo } from "../domain-intent.js";
import {
  CONFIRM_TTL_MS,
  confirmationRoomId,
  confirmTargetMismatchMessage,
  conflictingConfirmAmount,
  conflictingConfirmTarget,
  deleteCloudAppConfirmation,
  findPendingCloudAppConfirmation,
  markCloudAppConfirmationRecovery,
  pendingExpired,
  persistCloudAppConfirmation,
  readStructuredConfirmation,
} from "../safety.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY.";
const NO_PENDING_MESSAGE =
  "I don't have a pending influencer-booking confirmation for this room. Tell me who to book and the budget first, and I'll ask for confirmation.";
const CANCELED_MESSAGE = "Okay, I won't book that influencer.";
const ERROR_MESSAGE =
  "I couldn't fund that booking right now — the Cloud API returned an error.";

function readOpt(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const o = options as Record<string, unknown>;
  const nested = o.parameters;
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : o;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * The planner-extracted USD budget: `options.parameters.amount` first (the real
 * planner path nests validated args, same as readStructuredConfirmation), then
 * the top-level `amount` (direct handler calls / scenario turns).
 */
function optionAmount(options: unknown): number | null {
  if (!options || typeof options !== "object") return null;
  const opts = options as Record<string, unknown>;
  const nested =
    opts.parameters && typeof opts.parameters === "object"
      ? (opts.parameters as Record<string, unknown>)
      : undefined;
  for (const rec of [nested, opts]) {
    const v = rec?.amount;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string") {
      const n = Number(v.replace(/[$,]/g, "").trim());
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Parse the USD budget: planner option first, else an amount in the text WITH
 * an explicit currency cue ("$50", "50 dollars", "50 usd", "50 bucks"). A bare
 * number is NOT a budget — "book Nova, she has 80000 followers" must never
 * stage an $80,000 escrow.
 */
function parseAmount(options: unknown, body: string): number | null {
  const fromOptions = optionAmount(options);
  if (fromOptions !== null) return fromOptions;
  const m =
    /\$\s*(\d+(?:\.\d+)?)/.exec(body) ??
    /(\d+(?:\.\d+)?)\s*(?:dollars?|usd|bucks?)\b/i.exec(body);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export const bookInfluencerAction: Action = {
  name: "BOOK_INFLUENCER",
  similes: [
    "HIRE_INFLUENCER",
    "SPONSOR_INFLUENCER",
    "PAY_INFLUENCER",
    "PROMOTE_WITH_INFLUENCER",
  ],
  description:
    "Book (hire) an influencer on Eliza Cloud to promote — funds an escrowed offer from the org's credits. MONEY: the first ask only confirms intent; the booking is funded on explicit confirmation. Use when the user wants to hire/sponsor/pay an influencer.",
  descriptionCompressed:
    "Book an influencer to promote (escrowed; two-step confirm).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "profileId",
      description: "Influencer profile id to book.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "influencer",
      description: "Influencer display name to book (resolved via browse).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "amount",
      description: "USD budget for the booking.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "brief",
      description: "What the influencer should post / the campaign brief.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirm",
      description:
        "Follow-up: true confirms the pending booking, false cancels.",
      required: false,
      schema: { type: "boolean" },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["BOOK_INFLUENCER"] });
      return {
        success: false,
        text: "No Cloud API key.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const roomId = confirmationRoomId(runtime, message);
    const confirmation = readStructuredConfirmation(options);
    const pending = await findPendingCloudAppConfirmation(
      runtime,
      roomId,
      "BOOK_INFLUENCER",
    );

    // ---- Phase 2: a confirm/cancel came in ----
    if (confirmation !== null) {
      if (
        !pending ||
        typeof pending.metadata.amount !== "number" ||
        !pending.metadata.brief
      ) {
        await callback?.({
          text: NO_PENDING_MESSAGE,
          actions: ["BOOK_INFLUENCER"],
        });
        return {
          success: false,
          text: "No pending booking.",
          userFacingText: NO_PENDING_MESSAGE,
          data: { reason: "no_pending_confirmation" },
        };
      }
      const isRecovery = pending.metadata.recovery === true;
      if (confirmation === false) {
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        if (isRecovery) {
          // The earlier fund attempt failed at the transport level, so the
          // escrow may already be held server-side. Never claim "nothing
          // happened" — tell the user where to check and how to get a refund.
          const bookingsUrl = `${resolveCloudSiteBaseUrl(runtime)}/cloud/marketing/influencers`;
          const msg =
            `Okay — I won't retry that booking. Heads up: my earlier attempt to fund ${pending.metadata.appName} for ${usd(pending.metadata.amount)} didn't confirm either way, ` +
            `so the booking may already exist with the budget held in escrow. Check your bookings at ${bookingsUrl} — if it's there you can cancel it for a full refund.`;
          await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
          return {
            success: true,
            text: `Recovery retry for ${pending.metadata.appName} canceled; the earlier attempt may have funded the escrow.`,
            userFacingText: msg,
            verifiedUserFacing: true,
            data: { booked: false, canceled: true, recovery: true },
          };
        }
        await callback?.({
          text: CANCELED_MESSAGE,
          actions: ["BOOK_INFLUENCER"],
        });
        return {
          success: true,
          text: CANCELED_MESSAGE,
          userFacingText: CANCELED_MESSAGE,
          verifiedUserFacing: true,
          data: { booked: false, canceled: true },
        };
      }
      // Frozen-snapshot guard: a confirm whose own params name a DIFFERENT
      // influencer or budget must never fund the frozen booking the user is no
      // longer talking about. (`appId`/`appName` carry the profile id + display
      // name for this action.)
      const profileConflict = conflictingConfirmTarget(
        options,
        { name: pending.metadata.appName, id: pending.metadata.appId },
        ["profileId", "influencer"],
      );
      const budgetConflict = conflictingConfirmAmount(
        options,
        pending.metadata.amount,
      );
      if (profileConflict !== null || budgetConflict !== null) {
        const requested =
          profileConflict ??
          `${usd(budgetConflict ?? 0)} (not ${usd(pending.metadata.amount)})`;
        let msg: string;
        if (isRecovery) {
          msg =
            `Your confirmation names "${requested}", but the pending recovery retry is for "${pending.metadata.appName}" at ${usd(pending.metadata.amount)}. ` +
            `I did not retry or start a new booking, and I kept the recovery pending so its same escrow key survives. ` +
            `Reply to confirm again to safely complete or replay the earlier attempt, or cancel to leave it.`;
        } else {
          await deleteCloudAppConfirmation(runtime, pending.taskId);
          msg = confirmTargetMismatchMessage(
            requested,
            `booking of ${usd(pending.metadata.amount)}`,
            pending.metadata.appName,
          );
        }
        await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
        return {
          success: false,
          text: `Confirm named "${requested}" but the pending booking was ${pending.metadata.appName} for ${usd(pending.metadata.amount)}; refused.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: {
            reason: "confirm_target_mismatch",
            booked: false,
            requested,
            pendingTarget: {
              id: pending.metadata.appId,
              name: pending.metadata.appName,
            },
            amount: pending.metadata.amount,
            ...(isRecovery ? { recovery: true } : {}),
          },
        };
      }
      // A recovery retry never expires (safety.ts): it resumes/replays money
      // already committed under the same key rather than staging a new charge.
      if (pendingExpired(pending)) {
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        const msg =
          `That booking request for ${pending.metadata.appName} is more than ${Math.round(CONFIRM_TTL_MS / 60000)} minutes old, so I didn't fund anything. ` +
          `Ask me to book ${pending.metadata.appName} again and I'll re-confirm the details.`;
        await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
        return {
          success: false,
          text: `Pending booking of ${pending.metadata.appName} expired before confirmation.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: { reason: "confirmation_expired", booked: false },
        };
      }
      try {
        const result = await client.createBooking({
          profileId: pending.metadata.appId,
          brief: pending.metadata.brief,
          amount: pending.metadata.amount,
          // Stable per-confirmation key: the server dedupes/resumes on it, so
          // a retry of this confirm can never fund a second escrow. The
          // pending task is that key's ONLY holder — it must outlive any
          // transport failure of this call (#11844).
          idempotencyKey: `influencer-confirm-${pending.taskId}`,
        });
        // The server resolved the fund call at the business level (success or
        // a clean rejection with no money held) — only now is the pending
        // (and the idempotency key its taskId carries) done with.
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        if (!result.success) {
          const msg = result.error
            ? `I couldn't fund that booking: ${result.error}`
            : ERROR_MESSAGE;
          await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
          return {
            success: false,
            text: "Booking failed.",
            userFacingText: msg,
            data: { reason: "error" },
          };
        }
        const reply = isRecovery
          ? `Booked ${pending.metadata.appName} for ${usd(pending.metadata.amount)} — the retry completed the earlier attempt, so you were charged exactly once. The budget is held in escrow and released when you approve their deliverable.`
          : `Booked ${pending.metadata.appName} for ${usd(pending.metadata.amount)} — the budget is held in escrow and released when you approve their deliverable.`;
        await callback?.({ text: reply, actions: ["BOOK_INFLUENCER"] });
        return {
          success: true,
          text: `Booked ${pending.metadata.appName}.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            booked: true,
            booking: { id: result.booking?.id },
            amount: pending.metadata.amount,
            ...(isRecovery ? { recovery: true } : {}),
          },
        };
      } catch (err) {
        const info = cloudErrorInfo(err);
        logger.warn(
          `[BOOK_INFLUENCER] createBooking failed (${info.status ?? "transport"}/${info.code ?? "-"}): ${info.message}`,
        );
        if (info.status !== null && info.status < 500) {
          // The server answered with a definite rejection — no escrow was
          // held (a failed debit retires the funding row server-side), so the
          // confirm is settled and the pending can go.
          await deleteCloudAppConfirmation(runtime, pending.taskId);
          if (info.status === 402) {
            const billingUrl = `${resolveCloudSiteBaseUrl(runtime)}/cloud/billing`;
            const msg =
              `Not enough credits to book ${pending.metadata.appName} for ${usd(pending.metadata.amount)} — nothing was funded. ` +
              `Add credits and ask me again: ${billingUrl}`;
            await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
            return {
              success: false,
              text: "Insufficient credits for the booking.",
              userFacingText: msg,
              verifiedUserFacing: true,
              data: { reason: "insufficient_credits", booked: false },
            };
          }
          const msg = `I couldn't fund that booking: ${info.message}. Nothing was funded.`;
          await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
          return {
            success: false,
            text: `Booking rejected: ${info.message}`,
            userFacingText: msg,
            error: err instanceof Error ? err : new Error(String(err)),
            data: { reason: "error", booked: false },
          };
        }
        // Transport failure or 5xx: the outcome is UNKNOWN — the escrow may
        // be fully funded (response lost) or stranded mid-funding. KEEP the
        // pending and mark it recovery: its taskId is the sole holder of the
        // idempotency key, so a re-confirm re-sends the SAME key and the
        // server's funding resume finishes or replays the exact booking —
        // never a second hold (#11844).
        await markCloudAppConfirmationRecovery(runtime, pending);
        const msg =
          `I couldn't confirm whether the booking of ${pending.metadata.appName} for ${usd(pending.metadata.amount)} was funded — the Cloud API didn't answer. ` +
          `Reply to confirm again and I'll retry safely: the retry completes or replays this same booking and can never charge you twice. Or cancel and I'll leave it.`;
        await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
        return {
          success: false,
          text: `Fund call for ${pending.metadata.appName} failed in transit; kept the pending for a same-key retry.`,
          userFacingText: msg,
          error: err instanceof Error ? err : new Error(String(err)),
          data: { reason: "error", booked: false, recovery: true },
        };
      }
    }

    // ---- Phase 1: first ask — resolve target + persist a pending confirmation ----
    // Never stack pendings: while a fresh one is waiting, re-prompt for it so a
    // later bare confirm can only ever fund the booking the user was shown.
    if (pending && !pendingExpired(pending)) {
      const label = `${pending.metadata.appName}${
        typeof pending.metadata.amount === "number"
          ? ` for ${usd(pending.metadata.amount)}`
          : ""
      }`;
      const stillMsg =
        pending.metadata.recovery === true
          ? `My earlier attempt to fund the booking of ${label} didn't confirm either way. ` +
            `Reply to confirm and I'll retry safely — it completes or replays that same booking and can never charge you twice. Or cancel to leave it.`
          : `The booking of ${label} is still waiting for confirmation. ` +
            `Reply with a clear confirmation or cancellation.`;
      await callback?.({ text: stillMsg, actions: ["BOOK_INFLUENCER"] });
      return {
        success: true,
        text: `Awaiting structured confirmation to book ${pending.metadata.appName}.`,
        userFacingText: stillMsg,
        verifiedUserFacing: true,
        data: {
          booked: false,
          confirmationRequired: true,
          profileId: pending.metadata.appId,
          amount: pending.metadata.amount,
        },
      };
    }
    if (pending) {
      // Expired leftover: purge it so at most one pending booking exists per
      // room and a stale ask can never come back to life.
      await deleteCloudAppConfirmation(runtime, pending.taskId);
    }

    const rec = readOpt(options);
    const body = unwrapUserMessageText(message);
    const amount = parseAmount(options, body);
    const brief =
      typeof rec.brief === "string" && rec.brief.trim()
        ? rec.brief.trim()
        : "Promote our product";

    // Resolve the influencer profile: id directly, or by name via the same
    // ambiguity-aware matcher the app actions use (exact id → exact name →
    // whole-word-in-sentence → fragment; ties = ambiguous, ask the user).
    let profileId =
      typeof rec.profileId === "string" && rec.profileId.trim()
        ? rec.profileId.trim()
        : null;
    let profileName =
      typeof rec.influencer === "string" ? rec.influencer.trim() : "";
    if (!profileId) {
      const ref =
        (typeof rec.influencer === "string" && rec.influencer.trim()) ||
        body.trim();
      if (ref) {
        let match: ReferenceMatch<InfluencerProfileDto>;
        try {
          const { profiles } = await client.listInfluencers();
          match = matchByReference(profiles, ref, (p) => ({
            id: p.id,
            names: [p.display_name],
          }));
        } catch (err) {
          logger.warn(
            `[BOOK_INFLUENCER] listInfluencers failed while resolving "${appReferenceLogView(ref)}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          await callback?.({
            text: ERROR_MESSAGE,
            actions: ["BOOK_INFLUENCER"],
          });
          return {
            success: false,
            text: "Failed to resolve influencer.",
            userFacingText: ERROR_MESSAGE,
            error: err instanceof Error ? err : new Error(String(err)),
            data: { reason: "error" },
          };
        }
        if (match.item) {
          profileId = match.item.id;
          profileName = match.item.display_name;
        } else if (match.candidates.length > 1) {
          const names = match.candidates.map((p) => p.display_name);
          const msg = `Which influencer do you mean? ${describeAppReference(ref, "that name")} matches ${names.length}: ${names.join(", ")}. Reply with the exact name so I book the right one.`;
          await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
          return {
            success: false,
            text: `Ambiguous influencer reference "${appReferenceLogView(ref)}" (${names.length} matches).`,
            userFacingText: msg,
            data: {
              reason: "ambiguous",
              reference: appReferenceLogView(ref),
              candidates: names,
            },
          };
        }
      }
    }
    if (!profileId || !amount) {
      const msg = !profileId
        ? "Which influencer should I book? Tell me their name (I can browse the marketplace) and a budget."
        : "What budget should I book with? Tell me an amount in USD.";
      await callback?.({ text: msg, actions: ["BOOK_INFLUENCER"] });
      return {
        success: false,
        text: "Missing influencer or amount.",
        userFacingText: msg,
        data: { reason: "missing_input" },
      };
    }

    await persistCloudAppConfirmation(runtime, {
      roomId,
      action: "BOOK_INFLUENCER",
      appId: profileId,
      appName: profileName || "the influencer",
      amount,
      brief,
    });
    const prompt = `This will book ${profileName || "the influencer"} for ${usd(amount)} (brief: "${brief}"). The budget is held in escrow from your Cloud credits and released to them when you approve the deliverable — refunded if you cancel or reject. Reply to confirm booking ${profileName || "the influencer"} for ${usd(amount)}.`;
    await callback?.({ text: prompt, actions: ["BOOK_INFLUENCER"] });
    return {
      success: true,
      text: `Awaiting confirmation to book ${profileName || "the influencer"} for ${usd(amount)}.`,
      userFacingText: prompt,
      verifiedUserFacing: true,
      data: { confirmationRequired: true, profileId, amount },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "hire Nova to promote my app for $200" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'This will book Nova for $200.00 (brief: "Promote our product"). The budget is held in escrow from your Cloud credits and released to them when you approve the deliverable — refunded if you cancel or reject. Reply to confirm booking Nova for $200.00.',
          actions: ["BOOK_INFLUENCER"],
        },
      },
    ],
  ],
};
