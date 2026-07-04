/**
 * WITHDRAW_APP_EARNINGS — MONEY-OUT. Handled with maximum care.
 *
 * ── Safety model (documented per PR_EVIDENCE) ────────────────────────────────
 * Two layers protect the user's money, and NO secret/credential ever transits a
 * connector:
 *
 *   1. Two-phase confirm (structured `confirm` + pending task in safety.ts).
 *      The first ask NEVER moves money — it returns a confirmation prompt naming
 *      the exact app + amount, plus a connector-agnostic CTA to the dashboard
 *      earnings page. Money moves only when a later turn carries structured
 *      `confirm: true` for that pending prompt.
 *
 *   2. The "safe path" on confirm calls `client.withdrawAppEarnings(id, …)`,
 *      which wraps `POST /api/v1/apps/:id/earnings/withdraw`. That endpoint is
 *      idempotent (accepts an `idempotency_key`) and SERVER-GATED: the server
 *      independently verifies org ownership, app-creator identity, monetization,
 *      the minimum-payout threshold, and a sufficient withdrawable balance. It
 *      does NOT itself wire cash to a bank — it records the withdrawal request
 *      and moves the funds into the creator's redeemable balance; the actual
 *      cash-out (admin-gated Stripe Connect transfer / token redemption) is
 *      completed by the user IN THE BROWSER via the CTA. We therefore call the
 *      safe, idempotent, server-gated request endpoint on confirm AND hand off
 *      the dashboard CTA so the user finishes the money/credential step there.
 *
 * The CTA ({@link buildConnectorCta}) carries ONLY a human label + an https URL —
 * never a token, signed payload, secret, or amount baked into a credential.
 */

import type { AppDto, WithdrawAppEarningsRequest } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  extractAppReference,
  getCloudClient,
  plannerOptionSources,
  resolveApp,
  resolveCloudApiKey,
  resolveCloudSiteBaseUrl,
} from "../client.js";
import {
  buildConnectorCta,
  CONFIRM_TTL_MS,
  type ConnectorCta,
  confirmationRoomId,
  confirmTargetMismatchMessage,
  conflictingConfirmAmount,
  conflictingConfirmTarget,
  deleteCloudAppConfirmation,
  findPendingCloudAppConfirmation,
  pendingExpired,
  persistCloudAppConfirmation,
  readStructuredConfirmation,
} from "../safety.js";
import { extractEarningsView } from "./get-app-earnings.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can help you withdraw earnings.";
const NO_REFERENCE_MESSAGE =
  "Which app's earnings would you like to withdraw? Tell me its name.";
const ERROR_MESSAGE =
  "I couldn't process that withdrawal right now — the Cloud API returned an error. Nothing was withdrawn. Try again in a moment.";
const NO_PENDING_CONFIRMATION_MESSAGE =
  "I don't have a pending withdrawal confirmation for this room. Tell me which app earnings to withdraw first, and I'll ask for confirmation.";
const CANCELED_MESSAGE = "Canceled. No app earnings were withdrawn.";

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid; // 36 chars — within the server's 16–64 bound.
  return `wd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

const AMOUNT_OPTION_KEYS = ["amount", "usd", "value"] as const;

/**
 * Parse a withdrawal amount (USD) from planner options or text; null = "all".
 *
 * MONEY-CRITICAL: on the real planner path the validated `amount` arrives
 * NESTED under `options.parameters` (execute-planned-tool-call.ts), so the
 * nested object is read before the top level ({@link plannerOptionSources}).
 * Missing it here silently upgraded "withdraw $50" to the FULL withdrawable
 * balance at the confirm stage.
 */
export function parseWithdrawAmount(
  text: string,
  options?: unknown,
): number | null {
  for (const source of plannerOptionSources(options)) {
    for (const key of AMOUNT_OPTION_KEYS) {
      const v = source[key];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
      if (typeof v === "string") {
        const n = Number(v.replace(/[$,]/g, "").trim());
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  const body = text ?? "";
  // Prefer an explicit currency amount: "$50", "50 dollars", "50 usd". The
  // bare-number fallback requires a standalone whitespace-bounded token not
  // glued to letters, so a digit inside an app name ("Acme2") never reads as
  // a dollar amount.
  const m =
    /\$\s*(\d+(?:\.\d+)?)/.exec(body) ??
    /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:dollars?|usd)\b/i.exec(body) ??
    /\b(?:withdraw(?:al)?|cash\s*out|pay\s*out|payout)\b[^$\d]*?(?:^|\s)(\d+(?:\.\d+)?)(?![A-Za-z0-9])/i.exec(
      body,
    );
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching "${reference}".`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

export const withdrawAppEarningsAction: Action = {
  name: "WITHDRAW_APP_EARNINGS",
  similes: [
    "CASH_OUT",
    "PAYOUT",
    "WITHDRAW_EARNINGS",
    "REQUEST_PAYOUT",
    "CASH_OUT_APP",
  ],
  description:
    "Withdraw (cash out) an Eliza Cloud app's earnings. MONEY-OUT: requires an explicit confirmation — the first ask only confirms intent and hands off a dashboard link. Use when the user asks to withdraw, cash out, or request a payout of an app's earnings.",
  descriptionCompressed:
    "Withdraw a Cloud app's earnings (money-out; two-step confirm).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "appName",
      description:
        "Name, slug, or id of the Cloud app whose earnings to withdraw.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "amount",
      description:
        "Optional USD amount to withdraw on the first ask. Omit to withdraw the full available balance.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "confirm",
      description:
        "Follow-up confirmation. Set true only when the user is confirming the pending withdrawal prompt for this app and amount; set false when canceling.",
      required: false,
      schema: { type: "boolean" },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({
        text: NO_KEY_MESSAGE,
        actions: ["WITHDRAW_APP_EARNINGS"],
      });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const roomId = confirmationRoomId(runtime, message);
    const confirmation = readStructuredConfirmation(options);
    const pending = await findPendingCloudAppConfirmation(
      runtime,
      roomId,
      "WITHDRAW_APP_EARNINGS",
    );

    if (confirmation !== null) {
      if (!pending || typeof pending.metadata.amount !== "number") {
        await callback?.({
          text: NO_PENDING_CONFIRMATION_MESSAGE,
          actions: ["WITHDRAW_APP_EARNINGS"],
        });
        return {
          success: false,
          text: "No pending withdrawal confirmation.",
          userFacingText: NO_PENDING_CONFIRMATION_MESSAGE,
          data: { reason: "no_pending_confirmation", withdrawn: false },
        };
      }

      if (pendingExpired(pending)) {
        // A stale confirm must not fire a money-out withdrawal on a bare "yes"
        // long after the fact. Mirror BUY_APP_DOMAIN / BOOK_INFLUENCER: expire
        // the pending and ask the user to re-request rather than moving money.
        await deleteCloudAppConfirmation(runtime, pending.taskId);
        const msg =
          `That withdrawal request for ${pending.metadata.appName} is more than ${Math.round(CONFIRM_TTL_MS / 60000)} minutes old, so I didn't move any money. ` +
          `Ask me to withdraw ${pending.metadata.appName}'s earnings again and I'll re-confirm the amount.`;
        await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
        return {
          success: false,
          text: `Pending withdrawal of ${pending.metadata.appName} expired before confirmation.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: { reason: "confirmation_expired", withdrawn: false },
        };
      }

      await deleteCloudAppConfirmation(runtime, pending.taskId);
      if (confirmation === false) {
        await callback?.({
          text: CANCELED_MESSAGE,
          actions: ["WITHDRAW_APP_EARNINGS"],
        });
        return {
          success: true,
          text: CANCELED_MESSAGE,
          userFacingText: CANCELED_MESSAGE,
          verifiedUserFacing: true,
          data: { withdrawn: false, canceled: true },
        };
      }

      const target = {
        id: pending.metadata.appId,
        name: pending.metadata.appName,
        slug: pending.metadata.appSlug ?? pending.metadata.appName,
      };
      const amount = pending.metadata.amount;

      // Frozen-snapshot guard: a confirm whose own params name a DIFFERENT app
      // or amount must never fund the frozen withdrawal the user is no longer
      // talking about.
      const appConflict = conflictingConfirmTarget(options, {
        name: target.name,
        id: target.id,
        aliases: [target.slug],
      });
      const amountConflict = conflictingConfirmAmount(options, amount);
      if (appConflict !== null || amountConflict !== null) {
        const requested =
          appConflict ??
          `${usd(amountConflict ?? amount)} (not ${usd(amount)})`;
        const msg = confirmTargetMismatchMessage(
          requested,
          `withdrawal of ${usd(amount)}`,
          target.name,
        );
        await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
        return {
          success: false,
          text: `Confirm named "${requested}" but the pending withdrawal was ${usd(amount)} from ${target.name}; refused.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: {
            reason: "confirm_target_mismatch",
            withdrawn: false,
            requested,
            pendingTarget: { id: target.id, name: target.name },
            amount,
          },
        };
      }

      const cta =
        pending.metadata.cta ??
        buildConnectorCta(
          `Open ${target.name}'s earnings dashboard`,
          `${resolveCloudSiteBaseUrl(runtime)}/dashboard/apps/${target.id}?tab=earnings`,
          "link",
        );
      try {
        const request: WithdrawAppEarningsRequest = {
          amount,
          idempotency_key: newIdempotencyKey(),
        };
        const result = await client.withdrawAppEarnings(target.id, request);
        if (result.success === false) {
          const msg = `Couldn't withdraw from "${target.name}": ${
            result.error ?? result.message ?? "the request was rejected"
          }. Nothing was withdrawn.`;
          await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
          return {
            success: false,
            text: "Withdrawal rejected by the Cloud API.",
            userFacingText: msg,
            data: { reason: "rejected", withdrawn: false, cta },
          };
        }
        const newBalance =
          typeof result.newBalance === "number" ? result.newBalance : null;
        const reply =
          `Requested a payout of ${usd(amount)} from "${target.name}". ` +
          (result.message
            ? `${result.message} `
            : "It's now in your redeemable balance. ") +
          (newBalance !== null
            ? `Remaining withdrawable: ${usd(newBalance)}. `
            : "") +
          `Finish the cash-out here: ${cta.url}`;
        await callback?.({ text: reply, actions: ["WITHDRAW_APP_EARNINGS"] });
        return {
          success: true,
          text: `Withdrawal of ${usd(amount)} requested for ${target.name}.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            app: { id: target.id, name: target.name, slug: target.slug },
            amount,
            withdrawn: true,
            transactionId: result.transactionId ?? null,
            newBalance,
            cta,
          },
        };
      } catch (err) {
        logger.warn(
          `[WITHDRAW_APP_EARNINGS] withdrawAppEarnings(${target.id}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await callback?.({
          text: ERROR_MESSAGE,
          actions: ["WITHDRAW_APP_EARNINGS"],
        });
        return {
          success: false,
          text: "Failed to withdraw earnings.",
          userFacingText: ERROR_MESSAGE,
          error: err instanceof Error ? err : new Error(String(err)),
          data: { reason: "error", withdrawn: false, cta },
        };
      }
    }

    if (pending) {
      const msg =
        `Withdrawal for "${pending.metadata.appName}" is still waiting for confirmation. ` +
        `Reply with a clear confirmation or cancellation.`;
      await callback?.({
        text: msg,
        actions: ["WITHDRAW_APP_EARNINGS"],
      });
      return {
        success: true,
        text: `Awaiting structured confirmation to withdraw from ${pending.metadata.appName}.`,
        userFacingText: msg,
        verifiedUserFacing: true,
        data: {
          app: {
            id: pending.metadata.appId,
            name: pending.metadata.appName,
            slug: pending.metadata.appSlug,
          },
          amount: pending.metadata.amount,
          withdrawn: false,
          confirmationRequired: true,
          cta: pending.metadata.cta,
        },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({
        text: NO_REFERENCE_MESSAGE,
        actions: ["WITHDRAW_APP_EARNINGS"],
      });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    let app: AppDto | null;
    let available: string[];
    let ambiguous: string[] | undefined;
    try {
      ({ app, available, ambiguous } = await resolveApp(client, reference));
    } catch (err) {
      logger.warn(
        `[WITHDRAW_APP_EARNINGS] Failed to resolve app "${reference}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({
        text: ERROR_MESSAGE,
        actions: ["WITHDRAW_APP_EARNINGS"],
      });
      return {
        success: false,
        text: "Failed to resolve Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!app) {
      const candidates = ambiguous && ambiguous.length > 1 ? ambiguous : null;
      const msg = candidates
        ? `Which app do you mean? "${reference}" matches ${candidates.length}: ${candidates.join(", ")}. Reply with the exact name so I withdraw from the right one.`
        : notFoundMessage(reference, available);
      await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
      return {
        success: false,
        text: candidates
          ? `Ambiguous reference "${reference}" (${candidates.length} matches).`
          : `No app matched "${reference}".`,
        userFacingText: msg,
        data: {
          reason: candidates ? "ambiguous" : "not_found",
          reference,
          ...(candidates ? { candidates } : {}),
        },
      };
    }

    const target = app;

    // Read the authoritative balance/threshold (read-only) before doing anything.
    let withdrawable = 0;
    let threshold = 0;
    let monetizationOn = target.monetization_enabled;
    try {
      const earnings = await client.getAppEarnings(target.id);
      const view = extractEarningsView(earnings.earnings);
      if (view) {
        withdrawable = view.withdrawableBalance;
        threshold = view.payoutThreshold;
      }
      if (earnings.monetization?.enabled === true) monetizationOn = true;
      if (earnings.monetization?.enabled === false) monetizationOn = false;
    } catch (err) {
      logger.warn(
        `[WITHDRAW_APP_EARNINGS] getAppEarnings(${target.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({
        text: ERROR_MESSAGE,
        actions: ["WITHDRAW_APP_EARNINGS"],
      });
      return {
        success: false,
        text: "Failed to read earnings before withdrawal.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    // Connector-agnostic CTA — label + https URL only; never a secret/amount-token.
    const dashboardUrl = `${resolveCloudSiteBaseUrl(runtime)}/dashboard/apps/${
      target.id
    }?tab=earnings`;
    let cta: ConnectorCta;
    try {
      cta = buildConnectorCta(
        `Open ${target.name}'s earnings dashboard`,
        dashboardUrl,
        "link",
      );
    } catch (err) {
      // A malformed base URL must never block the read-only guidance.
      logger.warn(
        `[WITHDRAW_APP_EARNINGS] Could not build CTA: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      cta = {
        label: "Open your earnings dashboard",
        url: dashboardUrl,
        kind: "link",
      };
    }

    // Pre-checks: never start a withdrawal that the server would reject anyway.
    if (!monetizationOn) {
      const msg = `"${target.name}" isn't monetized, so there's nothing to withdraw. Turn on monetization first.`;
      await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
      return {
        success: false,
        text: "Monetization disabled — nothing to withdraw.",
        userFacingText: msg,
        data: { reason: "not_monetized", withdrawn: false, cta },
      };
    }

    if (withdrawable <= 0) {
      const msg = `"${target.name}" has no withdrawable balance yet. Earn a bit more and I'll help you cash out.`;
      await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
      return {
        success: false,
        text: "No withdrawable balance.",
        userFacingText: msg,
        data: { reason: "no_balance", withdrawn: false, cta },
      };
    }

    if (threshold > 0 && withdrawable < threshold) {
      const msg = `"${target.name}" has ${usd(
        withdrawable,
      )} withdrawable, but the minimum payout is ${usd(
        threshold,
      )}. Keep earning to reach it.`;
      await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
      return {
        success: false,
        text: "Below minimum payout threshold.",
        userFacingText: msg,
        data: { reason: "below_threshold", withdrawn: false, cta },
      };
    }

    // Amount: explicit request, else the full withdrawable balance.
    const requested = parseWithdrawAmount(message.content?.text ?? "", options);
    const amount = requested ?? withdrawable;

    if (amount > withdrawable + 1e-9) {
      const msg = `You asked to withdraw ${usd(amount)}, but only ${usd(
        withdrawable,
      )} is withdrawable right now. Ask for ${usd(withdrawable)} or less.`;
      await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
      return {
        success: false,
        text: "Requested amount exceeds withdrawable balance.",
        userFacingText: msg,
        data: { reason: "exceeds_balance", withdrawn: false, cta },
      };
    }
    if (threshold > 0 && amount < threshold) {
      const msg = `The minimum payout is ${usd(
        threshold,
      )}. Ask for at least that much (you have ${usd(withdrawable)} available).`;
      await callback?.({ text: msg, actions: ["WITHDRAW_APP_EARNINGS"] });
      return {
        success: false,
        text: "Requested amount below minimum payout.",
        userFacingText: msg,
        data: { reason: "below_threshold", withdrawn: false, cta },
      };
    }

    await persistCloudAppConfirmation(runtime, {
      roomId,
      action: "WITHDRAW_APP_EARNINGS",
      appId: target.id,
      appName: target.name,
      appSlug: target.slug,
      amount,
      cta,
    });
    const prompt =
      `This will request a payout of ${usd(amount)} from "${target.name}" ` +
      `(${target.id}). The funds move to your redeemable balance; you finish ` +
      `the cash-out on your dashboard — I never touch your bank details or keys. ` +
      `To go ahead, reply that you confirm withdrawing ${usd(amount)} from ${target.name}. ` +
      `Or open the dashboard: ${cta.url}`;
    await callback?.({ text: prompt, actions: ["WITHDRAW_APP_EARNINGS"] });
    return {
      success: true,
      text: `Awaiting structured confirmation to withdraw ${usd(amount)} from ${target.name}.`,
      userFacingText: prompt,
      verifiedUserFacing: true,
      data: {
        app: { id: target.id, name: target.name, slug: target.slug },
        amount,
        withdrawn: false,
        confirmationRequired: true,
        cta,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "withdraw my Acme Bot earnings" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'This will request a payout of $42.00 from "Acme Bot" (…). The funds move to your redeemable balance; you finish the cash-out on your dashboard — I never touch your bank details or keys. To go ahead, reply that you confirm withdrawing $42.00 from Acme Bot.',
          actions: ["WITHDRAW_APP_EARNINGS"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "I confirm the Acme Bot payout" } },
      {
        name: "{{agent}}",
        content: {
          text: 'Requested a payout of $42.00 from "Acme Bot". $42.00 marked as withdrawn. Check your Earnings page to redeem as elizaOS tokens. Finish the cash-out here: https://www.elizacloud.ai/dashboard/apps/…?tab=earnings',
          actions: ["WITHDRAW_APP_EARNINGS"],
        },
      },
    ],
  ],
};

export default withdrawAppEarningsAction;
