/**
 * BUY_APP_DOMAIN — MONEY-OUT. Buys a domain through the Cloudflare registrar
 * and attaches it to a Cloud app. Handled with maximum care.
 *
 * ── Safety model (documented per PR_EVIDENCE) ────────────────────────────────
 *   1. Two-phase confirm (structured `confirm` + pending task in safety.ts).
 *      The first ask NEVER buys — it runs a read-only availability + price
 *      check and returns a confirmation prompt naming the exact domain, app,
 *      charge, and renewal price. Money moves only when a later turn carries
 *      structured `confirm: true` for that pending prompt, and the purchase
 *      uses the app + domain FROZEN at quote time (never re-parsed prose).
 *   2. The confirmed PRICE is enforced, not just quoted: the confirm turn
 *      re-checks availability and refuses to buy when the current price no
 *      longer matches the confirmed cents — it re-quotes instead, so the org
 *      is never debited an amount the user did not confirm. Quotes also
 *      expire ({@link CONFIRM_TTL_MS}) and are re-quoted rather than charged.
 *   3. Interrupted purchases are never lost or lied about. The server's 502
 *      `persist_failed_recoverable` means charged + registered but not
 *      attached; a retried buy finishes it FREE. That state is persisted as a
 *      durable fact (domain-facts.ts), so canceling the staged recovery, an
 *      expired session, or a later fresh "buy X" all still route to the free
 *      recovery — and every reply about it states that the charge stands.
 *      Recovery confirmations carry no new charge, so they never expire; if
 *      the domain turns out to be freshly AVAILABLE at recovery time, the
 *      handler re-quotes at the current price instead of silently buying.
 *   4. The server is the real gate: `POST /apps/:id/domains/buy` debits fail-
 *      closed (402 before any registration), is idempotent per org+domain (a
 *      retry replays the earlier success instead of re-charging), and refunds
 *      exactly once if the registrar fails after the debit. This handler maps
 *      each outcome to an honest reply — it never says "bought" on a failure
 *      and never says "not charged" when money may have moved.
 *
 * The CTA ({@link buildConnectorCta}) carries ONLY a label + https URL —
 * money/credentials never transit the connector.
 */

import type {
  BuyAppDomainResponse,
  CheckAppDomainResponse,
} from "@elizaos/cloud-sdk";
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
  getCloudClient,
  resolveCloudApiKey,
  resolveCloudSiteBaseUrl,
} from "../client.js";
import {
  hasInterruptedDomainPurchase,
  recordInterruptedDomainPurchase,
  removeInterruptedDomainPurchase,
} from "../domain-facts.js";
import {
  cloudErrorInfo,
  extractDomainReferences,
  resolveDomainTargetApp,
  usdFromCents,
} from "../domain-intent.js";
import { invalidateAppsCache } from "../providers/cloud-apps.js";
import {
  buildConnectorCta,
  type ConnectorCta,
  confirmationRoomId,
  deleteCloudAppConfirmation,
  findPendingCloudAppConfirmation,
  type PendingCloudAppConfirmation,
  persistCloudAppConfirmation,
  readStructuredConfirmation,
} from "../safety.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can buy domains.";
const NO_DOMAIN_MESSAGE =
  "Which domain do you want to buy? Give me the full name, e.g. yourbrand.com.";
const NO_APPS_MESSAGE =
  "You don't have any Cloud apps yet — a domain attaches to an app, so create one first and then I can buy the domain for it.";
const ERROR_MESSAGE =
  "I couldn't process that domain purchase right now — the Cloud API returned an error. Nothing was purchased. Try again in a moment.";
const NO_PENDING_CONFIRMATION_MESSAGE =
  "I don't have a pending domain purchase to confirm for this room. Tell me which domain to buy first, and I'll quote the price and ask for confirmation.";
const CANCELED_MESSAGE = "Canceled. No domain was purchased.";

/** A quoted price is honored for this long; after that we re-quote. */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pendingExpired(
  pending: PendingCloudAppConfirmation,
  now: number = Date.now(),
): boolean {
  // A recovery retry completes with no new charge — there is no stale PRICE
  // to protect, and expiring it would strand a paid, unattached domain.
  if (pending.metadata.recovery === true) return false;
  const at =
    typeof pending.metadata.intentCreatedAt === "string"
      ? Date.parse(pending.metadata.intentCreatedAt)
      : Number.NaN;
  if (!Number.isFinite(at)) return false;
  return now - at > CONFIRM_TTL_MS;
}

function domainsCta(
  runtime: IAgentRuntime,
  app: { id: string; name: string },
): ConnectorCta {
  const url = `${resolveCloudSiteBaseUrl(runtime)}/dashboard/apps/${app.id}?tab=domains`;
  try {
    return buildConnectorCta(`Open "${app.name}"'s domains`, url, "link");
  } catch (err) {
    // A malformed base URL must never block guidance.
    logger.warn(
      `[BUY_APP_DOMAIN] Could not build CTA: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { label: "Open your app's domains", url, kind: "link" };
  }
}

/**
 * Run the purchase, absorbing exactly one server-directed retry: a 409 with
 * code `idempotency_retry` means a stale claim from a dead worker was just
 * reaped and the server asks the client to simply re-send.
 */
async function executeBuy(
  buy: () => Promise<BuyAppDomainResponse>,
): Promise<{ res: BuyAppDomainResponse } | { err: unknown }> {
  try {
    return { res: await buy() };
  } catch (err) {
    const info = cloudErrorInfo(err);
    if (info.status === 409 && info.code === "idempotency_retry") {
      try {
        return { res: await buy() };
      } catch (retryErr) {
        return { err: retryErr };
      }
    }
    return { err };
  }
}

/** Stage a purchase confirmation and return the prompt reply. */
async function stagePurchaseConfirmation(
  runtime: IAgentRuntime,
  callback: HandlerCallback | undefined,
  args: {
    roomId: string;
    app: { id: string; name: string; slug?: string };
    domain: string;
    priceUsdCents: number;
    renewalUsdCents: number;
    cta: ConnectorCta;
    /** Extra sentence prepended to the standard prompt (e.g. "price changed"). */
    preamble?: string;
    defaultedApp?: boolean;
  },
): Promise<ActionResult> {
  const { roomId, app, domain, priceUsdCents, renewalUsdCents, cta } = args;
  await persistCloudAppConfirmation(runtime, {
    roomId,
    action: "BUY_APP_DOMAIN",
    appId: app.id,
    appName: app.name,
    appSlug: app.slug,
    amount: priceUsdCents / 100,
    amountUsdCents: priceUsdCents,
    domain,
    cta,
  });
  const prompt =
    `${args.preamble ? `${args.preamble} ` : ""}` +
    `Buying ${domain} for "${app.name}" (${app.id}) will charge ${usdFromCents(priceUsdCents)} ` +
    `from your Eliza Cloud credit balance now, and it auto-renews at ${usdFromCents(renewalUsdCents)}/yr ` +
    `(manage or cancel on the dashboard). To go ahead, reply that you confirm buying ${domain}. ` +
    `Or use the dashboard: ${cta.url}`;
  await callback?.({ text: prompt, actions: ["BUY_APP_DOMAIN"] });
  return {
    success: true,
    text: `Awaiting structured confirmation to buy ${domain} for ${app.name} at ${usdFromCents(priceUsdCents)}.`,
    userFacingText: prompt,
    verifiedUserFacing: true,
    data: {
      app: { id: app.id, name: app.name, slug: app.slug },
      domain,
      amount: priceUsdCents / 100,
      renewalUsdCents,
      purchased: false,
      confirmationRequired: true,
      ...(args.defaultedApp !== undefined
        ? { defaultedApp: args.defaultedApp }
        : {}),
      cta,
    },
  };
}

/** Stage a no-charge recovery confirmation and return the prompt reply. */
async function stageRecoveryConfirmation(
  runtime: IAgentRuntime,
  callback: HandlerCallback | undefined,
  args: {
    roomId: string;
    app: { id: string; name: string; slug?: string };
    domain: string;
    cta: ConnectorCta;
    reason: string;
  },
): Promise<ActionResult> {
  const { roomId, app, domain, cta } = args;
  await persistCloudAppConfirmation(runtime, {
    roomId,
    action: "BUY_APP_DOMAIN",
    appId: app.id,
    appName: app.name,
    appSlug: app.slug,
    domain,
    recovery: true,
    cta,
  });
  const msg =
    `${domain} was charged and registered to you, but the final attach to "${app.name}" didn't complete. ` +
    `Reply that you confirm and I'll finish the setup — you will NOT be charged again.`;
  await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
  return {
    success: false,
    text: `Purchase of ${domain} registered but not attached; staged a no-charge recovery retry.`,
    userFacingText: msg,
    verifiedUserFacing: true,
    data: {
      reason: args.reason,
      purchased: true,
      attached: false,
      confirmationRequired: true,
      recovery: true,
      domain,
      cta,
    },
  };
}

export const buyAppDomainAction: Action = {
  name: "BUY_APP_DOMAIN",
  similes: [
    "BUY_DOMAIN",
    "PURCHASE_DOMAIN",
    "REGISTER_DOMAIN",
    "GET_A_DOMAIN",
    "BUY_CUSTOM_DOMAIN",
  ],
  description:
    "Buy a domain through Eliza Cloud (Cloudflare registrar) and attach it to a Cloud app. MONEY-OUT: charged from the org credit balance — the first ask only quotes the price and asks for confirmation. Use when the user asks to buy, purchase, or register a domain.",
  descriptionCompressed:
    "Buy + attach a domain to a Cloud app (money-out; two-step confirm).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "domain",
      description: "The domain to buy, e.g. yourbrand.com.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "appName",
      description: "Name, slug, or id of the Cloud app the domain attaches to.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirm",
      description:
        "Follow-up confirmation. Set true only when the user is confirming the pending domain-purchase prompt; set false when canceling.",
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["BUY_APP_DOMAIN"] });
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
      "BUY_APP_DOMAIN",
    );

    if (confirmation !== null) {
      if (!pending || typeof pending.metadata.domain !== "string") {
        await callback?.({
          text: NO_PENDING_CONFIRMATION_MESSAGE,
          actions: ["BUY_APP_DOMAIN"],
        });
        return {
          success: false,
          text: "No pending domain-purchase confirmation.",
          userFacingText: NO_PENDING_CONFIRMATION_MESSAGE,
          data: { reason: "no_pending_confirmation", purchased: false },
        };
      }

      await deleteCloudAppConfirmation(runtime, pending.taskId);
      const isRecovery = pending.metadata.recovery === true;
      const target = {
        id: pending.metadata.appId,
        name: pending.metadata.appName,
        slug: pending.metadata.appSlug,
      };
      const domain = pending.metadata.domain;
      const cta = pending.metadata.cta ?? domainsCta(runtime, target);

      if (confirmation === false) {
        if (isRecovery) {
          // The purchase already happened — canceling only skips the attach.
          // Never claim "no domain was purchased"; the debit stands and the
          // domain is registered to the org.
          const msg =
            `Okay — I won't finish the setup now. Keep in mind ${domain} was already charged and registered to you; ` +
            `only the attach to "${target.name}" is missing. Say "buy ${domain}" again anytime and I'll complete it ` +
            `without a new charge, or finish on the dashboard: ${cta.url}`;
          await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
          return {
            success: true,
            text: `Recovery of ${domain} canceled; the earlier charge and registration stand.`,
            userFacingText: msg,
            verifiedUserFacing: true,
            data: {
              reason: "recovery_canceled",
              purchased: true,
              attached: false,
              canceled: true,
              domain,
              cta,
            },
          };
        }
        await callback?.({
          text: CANCELED_MESSAGE,
          actions: ["BUY_APP_DOMAIN"],
        });
        return {
          success: true,
          text: CANCELED_MESSAGE,
          userFacingText: CANCELED_MESSAGE,
          verifiedUserFacing: true,
          data: { purchased: false, canceled: true },
        };
      }

      if (pendingExpired(pending)) {
        const msg =
          `That quote for ${domain} is more than ${Math.round(CONFIRM_TTL_MS / 60000)} minutes old and prices can change, so I didn't charge anything. ` +
          `Ask me to buy ${domain} again and I'll get a fresh quote.`;
        await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
        return {
          success: false,
          text: `Pending purchase of ${domain} expired before confirmation.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: { reason: "confirmation_expired", purchased: false, domain },
        };
      }

      // Re-verify availability + price at purchase time. The server debits
      // the CURRENT price, so buying without this check could charge an
      // amount the user never confirmed.
      let recheck: CheckAppDomainResponse;
      try {
        recheck = await client.checkAppDomain(target.id, { domain });
      } catch (err) {
        logger.warn(
          `[BUY_APP_DOMAIN] confirm-time checkAppDomain(${target.id}, ${domain}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        const msg = `I couldn't re-verify ${domain} with Eliza Cloud just now, so I didn't buy anything. Ask me to buy ${domain} again in a moment.`;
        await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
        return {
          success: false,
          text: `Confirm-time re-check failed for ${domain}; refused to buy blind.`,
          userFacingText: msg,
          error: err instanceof Error ? err : new Error(String(err)),
          data: { reason: "precheck_failed", purchased: false, domain },
        };
      }

      let proceedToBuy = false;
      if (isRecovery) {
        if (recheck.available) {
          // The domain is genuinely registrable now — that would be a NEW
          // charge at the current price, which the user has not confirmed.
          const priceUsdCents = recheck.price?.totalUsdCents;
          if (typeof priceUsdCents !== "number" || priceUsdCents <= 0) {
            await callback?.({
              text: ERROR_MESSAGE,
              actions: ["BUY_APP_DOMAIN"],
            });
            return {
              success: false,
              text: `Recovery re-check for ${domain} returned available with no price; refusing to buy.`,
              userFacingText: ERROR_MESSAGE,
              data: { reason: "no_price", purchased: false, domain },
            };
          }
          return stagePurchaseConfirmation(runtime, callback, {
            roomId,
            app: target,
            domain,
            priceUsdCents,
            renewalUsdCents: recheck.renewal?.totalUsdCents ?? priceUsdCents,
            cta,
            preamble: `${domain} is showing as openly available to register now, so finishing it would be a NEW purchase rather than a free recovery.`,
          });
        }
        proceedToBuy = true; // still unavailable → the free recovery path
      } else if (!recheck.available) {
        if (
          await hasInterruptedDomainPurchase(
            runtime,
            message,
            target.id,
            domain,
          )
        ) {
          proceedToBuy = true; // our own charged+registered orphan — buy recovers it free
        } else {
          const msg = `${domain} is no longer available to register — it may have just been taken. You were NOT charged.`;
          await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
          return {
            success: false,
            text: `${domain} became unavailable between quote and confirm; no purchase.`,
            userFacingText: msg,
            verifiedUserFacing: true,
            data: { reason: "unavailable", purchased: false, domain },
          };
        }
      } else {
        const priceUsdCents = recheck.price?.totalUsdCents;
        const confirmedUsdCents = pending.metadata.amountUsdCents;
        if (typeof priceUsdCents !== "number" || priceUsdCents <= 0) {
          await callback?.({
            text: ERROR_MESSAGE,
            actions: ["BUY_APP_DOMAIN"],
          });
          return {
            success: false,
            text: `Confirm-time re-check for ${domain} returned no price; refusing to buy.`,
            userFacingText: ERROR_MESSAGE,
            data: { reason: "no_price", purchased: false, domain },
          };
        }
        if (
          typeof confirmedUsdCents !== "number" ||
          priceUsdCents !== confirmedUsdCents
        ) {
          // Price moved (or the confirmed amount is missing) — never charge a
          // figure the user did not see. Re-quote at the current price.
          return stagePurchaseConfirmation(runtime, callback, {
            roomId,
            app: target,
            domain,
            priceUsdCents,
            renewalUsdCents: recheck.renewal?.totalUsdCents ?? priceUsdCents,
            cta,
            preamble:
              typeof confirmedUsdCents === "number"
                ? `The price of ${domain} changed from ${usdFromCents(confirmedUsdCents)} to ${usdFromCents(priceUsdCents)} since I quoted you, so I didn't charge anything.`
                : `I couldn't verify the price you confirmed for ${domain}, so I didn't charge anything.`,
          });
        }
        proceedToBuy = true;
      }

      if (!proceedToBuy) {
        // Unreachable by construction — every branch above returns or sets it.
        await callback?.({ text: ERROR_MESSAGE, actions: ["BUY_APP_DOMAIN"] });
        return {
          success: false,
          text: "Internal confirm-turn state error; no purchase attempted.",
          userFacingText: ERROR_MESSAGE,
          data: { reason: "error", purchased: false, domain },
        };
      }

      const outcome = await executeBuy(() =>
        client.buyAppDomain(target.id, { domain }),
      );

      if ("err" in outcome) {
        const info = cloudErrorInfo(outcome.err);
        logger.warn(
          `[BUY_APP_DOMAIN] buyAppDomain(${target.id}, ${domain}) failed (${info.status ?? "?"}/${info.code ?? "-"}): ${info.message}`,
        );

        if (info.status === 402) {
          const billingUrl = `${resolveCloudSiteBaseUrl(runtime)}/dashboard/billing`;
          const msg =
            `Not enough credits to buy ${domain} — nothing was purchased. ` +
            `Add credits and ask me again: ${billingUrl}`;
          await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
          return {
            success: false,
            text: "Insufficient credits for the domain purchase.",
            userFacingText: msg,
            verifiedUserFacing: true,
            data: {
              reason: "insufficient_credits",
              purchased: false,
              domain,
              cta: { label: "Add credits", url: billingUrl, kind: "link" },
            },
          };
        }

        if (info.status === 409 && info.code === "idempotency_in_progress") {
          const msg = `A purchase of ${domain} is already in progress. Give it a minute, then ask me to list your domains to confirm it landed.`;
          await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
          return {
            success: false,
            text: `Purchase of ${domain} already in progress server-side.`,
            userFacingText: msg,
            verifiedUserFacing: true,
            data: { reason: "in_progress", purchased: false, domain, cta },
          };
        }

        if (info.status === 409) {
          const msg = `Couldn't buy ${domain}: ${info.message}. You were not charged.`;
          await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
          return {
            success: false,
            text: `Domain purchase rejected: ${info.message}`,
            userFacingText: msg,
            verifiedUserFacing: true,
            data: { reason: "rejected", purchased: false, domain, cta },
          };
        }

        if (info.status === 502 && info.code === "persist_failed_recoverable") {
          // Charged + registered, but the attach didn't complete. Persist the
          // durable marker FIRST (it is what keeps the free recovery reachable
          // after cancels/restarts), then stage the recovery confirmation.
          await recordInterruptedDomainPurchase(
            runtime,
            message,
            { id: target.id, name: target.name },
            domain,
          );
          return stageRecoveryConfirmation(runtime, callback, {
            roomId,
            app: target,
            domain,
            cta,
            reason: "persist_failed_recoverable",
          });
        }

        if (info.status === 502) {
          const msg = `The registrar couldn't complete the purchase of ${domain}: ${info.message}. The charge was automatically refunded in full.`;
          await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
          return {
            success: false,
            text: `Registrar failed for ${domain}; server refunded the debit.`,
            userFacingText: msg,
            verifiedUserFacing: true,
            data: { reason: "registrar_failed", purchased: false, domain, cta },
          };
        }

        const msg =
          `Something went wrong buying ${domain} — the purchase may or may not have completed. ` +
          `Check your app's Domains tab before retrying: ${cta.url}`;
        await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
        return {
          success: false,
          text: `Domain purchase errored with an unknown outcome for ${domain}.`,
          userFacingText: msg,
          error:
            outcome.err instanceof Error
              ? outcome.err
              : new Error(String(outcome.err)),
          data: { reason: "error", purchased: false, domain, cta },
        };
      }

      const res = outcome.res;
      if (res.success === false) {
        const msg = `Couldn't buy ${domain}: ${res.error ?? "the request was rejected"}. Nothing was purchased.`;
        await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
        return {
          success: false,
          text: "Domain purchase rejected by the Cloud API.",
          userFacingText: msg,
          data: { reason: "rejected", purchased: false, domain, cta },
        };
      }

      // The app row (custom domain / URL) just changed server-side, and any
      // interrupted-purchase marker for this domain is now resolved.
      invalidateAppsCache(runtime);
      await removeInterruptedDomainPurchase(
        runtime,
        message,
        target.id,
        domain,
      );

      const zoneNote = res.pendingZoneProvisioning
        ? " DNS is still being set up — it can take a few minutes to go live."
        : " It's connecting to your app now.";
      const noCharge =
        res.alreadyRegistered === true || res.recoveredFromRegistrar === true;
      const reply = noCharge
        ? `${domain} was already registered to you — I attached it to "${target.name}" without charging you again.${zoneNote}`
        : `Bought ${domain} for "${target.name}" — charged ${
            res.debited
              ? usdFromCents(res.debited.totalUsdCents)
              : typeof pending.metadata.amount === "number"
                ? usd(pending.metadata.amount)
                : "the quoted price"
          } from your credit balance.${zoneNote}`;
      await callback?.({ text: reply, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: true,
        text: `Purchased ${domain} for ${target.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: target.id, name: target.name },
          domain,
          purchased: true,
          charged: !noCharge,
          pendingZoneProvisioning: res.pendingZoneProvisioning === true,
          debitedUsdCents: res.debited?.totalUsdCents ?? null,
          cta,
        },
      };
    }

    if (pending && !pendingExpired(pending)) {
      const requested = extractDomainReferences(message, options);
      const otherDomain =
        requested.length === 1 && requested[0] !== pending.metadata.domain
          ? requested[0]
          : null;
      const msg = otherDomain
        ? `I'm still waiting on the pending purchase of ${pending.metadata.domain ?? "a domain"} for "${pending.metadata.appName}". ` +
          `Reply with a clear confirmation or cancellation first — then I can look at ${otherDomain}.`
        : `The purchase of ${pending.metadata.domain ?? "that domain"} for "${pending.metadata.appName}" is still waiting for confirmation. ` +
          `Reply with a clear confirmation or cancellation.`;
      await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: true,
        text: `Awaiting structured confirmation to buy ${pending.metadata.domain}.`,
        userFacingText: msg,
        verifiedUserFacing: true,
        data: {
          app: {
            id: pending.metadata.appId,
            name: pending.metadata.appName,
          },
          domain: pending.metadata.domain,
          ...(otherDomain ? { deferredDomain: otherDomain } : {}),
          purchased: false,
          confirmationRequired: true,
          cta: pending.metadata.cta,
        },
      };
    }
    if (pending) {
      // Expired quote lying around — discard it and fall through to a fresh ask.
      await deleteCloudAppConfirmation(runtime, pending.taskId);
    }

    const domains = extractDomainReferences(message, options);
    if (domains.length === 0) {
      await callback?.({
        text: NO_DOMAIN_MESSAGE,
        actions: ["BUY_APP_DOMAIN"],
      });
      return {
        success: false,
        text: "No domain reference supplied.",
        userFacingText: NO_DOMAIN_MESSAGE,
        data: { reason: "no_domain" },
      };
    }
    if (domains.length > 1) {
      const msg = `One domain at a time for purchases — which one do you want: ${domains.join(", ")}?`;
      await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: false,
        text: `Multiple domains named (${domains.length}); refusing to guess.`,
        userFacingText: msg,
        data: { reason: "multiple_domains", domains },
      };
    }
    const domain = domains[0];

    let resolved: Awaited<ReturnType<typeof resolveDomainTargetApp>>;
    try {
      resolved = await resolveDomainTargetApp(client, message, options);
    } catch (err) {
      logger.warn(
        `[BUY_APP_DOMAIN] failed to resolve app: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: false,
        text: "Failed to resolve the target Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!resolved.app) {
      if (resolved.available.length === 0) {
        await callback?.({
          text: NO_APPS_MESSAGE,
          actions: ["BUY_APP_DOMAIN"],
        });
        return {
          success: false,
          text: "User has no Cloud apps to attach a domain to.",
          userFacingText: NO_APPS_MESSAGE,
          data: { reason: "no_apps" },
        };
      }
      const candidates =
        resolved.ambiguous && resolved.ambiguous.length > 1
          ? resolved.ambiguous
          : resolved.available;
      const msg = `Which app should ${domain} attach to? ${
        resolved.ambiguous
          ? `That matches ${candidates.length}: ${candidates.join(", ")}.`
          : `Your apps are: ${candidates.join(", ")}.`
      } Reply with the exact name.`;
      await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: false,
        text: resolved.ambiguous
          ? `Ambiguous app reference for the ${domain} purchase.`
          : `No app matched for the ${domain} purchase.`,
        userFacingText: msg,
        data: {
          reason: resolved.ambiguous ? "ambiguous" : "not_found",
          domain,
          candidates,
        },
      };
    }
    const app = resolved.app;

    // Read-only pre-check: never stage a purchase the server would reject.
    let check: CheckAppDomainResponse;
    try {
      check = await client.checkAppDomain(app.id, { domain });
    } catch (err) {
      logger.warn(
        `[BUY_APP_DOMAIN] checkAppDomain(${app.id}, ${domain}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: false,
        text: "Availability pre-check failed.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error", domain },
      };
    }

    if (!check.available) {
      // Already attached to this app? Say so instead of "taken".
      let alreadyAttached = false;
      try {
        const { domains: attached } = await client.listAppDomains(app.id);
        alreadyAttached = (attached ?? []).some((d) => d.domain === domain);
      } catch {
        // best-effort — fall through to the other unavailable branches
      }
      if (alreadyAttached) {
        // Any interrupted-purchase marker is stale once the attach exists.
        await removeInterruptedDomainPurchase(runtime, message, app.id, domain);
        const msg = `${domain} is already attached to "${app.name}" — nothing to buy.`;
        await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
        return {
          success: true,
          text: `${domain} already attached to ${app.name}.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: { reason: "already_attached", purchased: false, domain },
        };
      }

      // A domain WE charged + registered but never attached also reads as
      // "unavailable" — route it to the free recovery instead of dead-ending.
      if (
        await hasInterruptedDomainPurchase(runtime, message, app.id, domain)
      ) {
        return stageRecoveryConfirmation(runtime, callback, {
          roomId,
          app,
          domain,
          cta: domainsCta(runtime, app),
          reason: "recovery_staged",
        });
      }

      const msg = `${domain} isn't available to register. Want me to check some alternatives?`;
      await callback?.({ text: msg, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: false,
        text: `${domain} not available to register.`,
        userFacingText: msg,
        verifiedUserFacing: true,
        data: { reason: "unavailable", purchased: false, domain },
      };
    }

    const priceUsdCents = check.price?.totalUsdCents;
    if (typeof priceUsdCents !== "number" || priceUsdCents <= 0) {
      // Never stage a money confirmation without a concrete price.
      await callback?.({ text: ERROR_MESSAGE, actions: ["BUY_APP_DOMAIN"] });
      return {
        success: false,
        text: `Availability check for ${domain} returned no price; refusing to quote.`,
        userFacingText: ERROR_MESSAGE,
        data: { reason: "no_price", domain },
      };
    }

    return stagePurchaseConfirmation(runtime, callback, {
      roomId,
      app,
      domain,
      priceUsdCents,
      renewalUsdCents: check.renewal?.totalUsdCents ?? priceUsdCents,
      cta: domainsCta(runtime, app),
      defaultedApp: resolved.defaulted === true,
    });
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "buy coolbrand.com for Acme Bot" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Buying coolbrand.com for "Acme Bot" (…) will charge $13.99 from your Eliza Cloud credit balance now, and it auto-renews at $13.99/yr (manage or cancel on the dashboard). To go ahead, reply that you confirm buying coolbrand.com.',
          actions: ["BUY_APP_DOMAIN"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "yes, I confirm — buy it" },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Bought coolbrand.com for "Acme Bot" — charged $13.99 from your credit balance. DNS is still being set up — it can take a few minutes to go live.',
          actions: ["BUY_APP_DOMAIN"],
        },
      },
    ],
  ],
};

export default buyAppDomainAction;
