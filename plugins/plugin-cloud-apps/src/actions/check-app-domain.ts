/**
 * Quotes domain availability and annual pricing for a published Project.
 *
 * Wraps `POST /api/v1/apps/:id/domains/check` (a dry run: the server never
 * charges and never registers on this route). Reports availability, the
 * purchase price, and the annual renewal price the renewal cron will
 * re-charge, then points the user at BUY_APP_DOMAIN for the actual purchase.
 *
 * The Cloud endpoint is app-scoped even though its quote is app-agnostic. The
 * action therefore resolves a local Project first and uses only that project's
 * durable Cloud binding; it never borrows an unrelated Cloud app as transport.
 */

import type { CheckAppDomainResponse } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { getCloudClient, resolveCloudApiKey } from "../client.js";
import {
  domainProjectResolutionMessage,
  extractDomainReferences,
  resolveDomainTargetProject,
  usdFromCents,
} from "../domain-intent.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can check domains.";
const NO_DOMAIN_MESSAGE =
  "Which domain should I check? Give me the full name, e.g. yourbrand.com.";
const ERROR_MESSAGE =
  "I couldn't check that domain right now — the Cloud API returned an error. Try again in a moment.";

/** Read-only checks stay cheap: quote at most this many domains per ask. */
const MAX_DOMAINS_PER_CHECK = 3;

interface DomainQuote {
  domain: string;
  available: boolean;
  priceUsdCents: number | null;
  renewalUsdCents: number | null;
}

function quoteLine(quote: DomainQuote): string {
  if (!quote.available) {
    return `✖ ${quote.domain} is not available.`;
  }
  if (quote.priceUsdCents === null) {
    return `✔ ${quote.domain} is available.`;
  }
  const renewal =
    quote.renewalUsdCents !== null
      ? ` (renews at ${usdFromCents(quote.renewalUsdCents)}/yr)`
      : "";
  return `✔ ${quote.domain} is available — ${usdFromCents(quote.priceUsdCents)}/yr${renewal}.`;
}

function toQuote(res: CheckAppDomainResponse): DomainQuote {
  return {
    domain: res.domain,
    available: res.available === true,
    priceUsdCents:
      typeof res.price?.totalUsdCents === "number"
        ? res.price.totalUsdCents
        : null,
    renewalUsdCents:
      typeof res.renewal?.totalUsdCents === "number"
        ? res.renewal.totalUsdCents
        : null,
  };
}

export const checkAppDomainAction: Action = {
  name: "CHECK_APP_DOMAIN",
  similes: [
    "CHECK_DOMAIN",
    "DOMAIN_AVAILABLE",
    "DOMAIN_PRICE",
    "SEARCH_DOMAIN",
    "IS_DOMAIN_AVAILABLE",
  ],
  description:
    "Check whether a domain is available to register and what it costs per year (purchase + renewal). Read-only — never charges or registers. Use when the user asks if a domain is available, free, taken, or how much it costs.",
  descriptionCompressed:
    "Check a domain's availability + yearly price (read-only).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "domain",
      description: "The domain to check, e.g. yourbrand.com.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "project",
      description:
        "Optional local project name or id. Omit to use the active or sole project.",
      required: false,
      schema: { type: "string" },
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["CHECK_APP_DOMAIN"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const domains = extractDomainReferences(message, options);
    if (domains.length === 0) {
      await callback?.({
        text: NO_DOMAIN_MESSAGE,
        actions: ["CHECK_APP_DOMAIN"],
      });
      return {
        success: false,
        text: "No domain reference supplied.",
        userFacingText: NO_DOMAIN_MESSAGE,
        data: { reason: "no_domain" },
      };
    }

    let target: Awaited<ReturnType<typeof resolveDomainTargetProject>>;
    try {
      target = await resolveDomainTargetProject(client, message, options);
    } catch (err) {
      // error-policy:J1 The action boundary translates project and Cloud failures for the planner.
      logger.warn(
        `[CHECK_APP_DOMAIN] failed to resolve a published project: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["CHECK_APP_DOMAIN"] });
      return {
        success: false,
        text: "Failed to resolve a published project for the domain check.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
    if (!target.project || !target.app) {
      const reply = domainProjectResolutionMessage(target);
      await callback?.({ text: reply, actions: ["CHECK_APP_DOMAIN"] });
      return {
        success: false,
        text: "Published project could not be resolved.",
        userFacingText: reply,
        data: { reason: target.reason },
      };
    }
    const { app, project } = target;

    // Per-domain checks are independent — a failure on one must not discard
    // the quotes already fetched for the others.
    const toCheck = domains.slice(0, MAX_DOMAINS_PER_CHECK);
    const quotes: DomainQuote[] = [];
    const failed: string[] = [];
    for (const domain of toCheck) {
      try {
        const res = await client.checkAppDomain(app.id, { domain });
        quotes.push(toQuote(res));
      } catch (err) {
        // error-policy:J4 Each independent quote failure is named in the partial-result reply.
        logger.warn(
          `[CHECK_APP_DOMAIN] checkAppDomain(${app.id}, ${domain}) failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        failed.push(domain);
      }
    }
    if (quotes.length === 0) {
      await callback?.({ text: ERROR_MESSAGE, actions: ["CHECK_APP_DOMAIN"] });
      return {
        success: false,
        text: "Domain availability check failed.",
        userFacingText: ERROR_MESSAGE,
        data: { reason: "error", failed },
      };
    }

    const lines = quotes.map(quoteLine);
    for (const domain of failed) {
      lines.push(
        `✖ Couldn't check ${domain} right now — try again in a moment.`,
      );
    }
    const firstAvailable = quotes.find((q) => q.available);
    if (firstAvailable) {
      lines.push(
        `Say "buy ${firstAvailable.domain}" and I'll set it up (you confirm the price first).`,
      );
    }
    if (domains.length > toCheck.length) {
      lines.push(
        `(I checked the first ${toCheck.length} — ask again for the rest.)`,
      );
    }
    const reply = lines.join("\n");
    await callback?.({ text: reply, actions: ["CHECK_APP_DOMAIN"] });
    return {
      success: true,
      text: `Checked ${quotes.length} domain(s): ${quotes
        .map((q) => `${q.domain}=${q.available ? "available" : "taken"}`)
        .join(", ")}.`,
      userFacingText: reply,
      verifiedUserFacing: true,
      data: {
        project: {
          id: project.id,
          name: project.name,
          cloudAppId: project.cloudAppId,
        },
        app: { id: app.id, name: app.name, slug: app.slug },
        quotes,
        ...(failed.length > 0 ? { failed } : {}),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "is coolbrand.com available?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '✔ coolbrand.com is available — $13.99/yr (renews at $13.99/yr).\nSay "buy coolbrand.com" and I\'ll set it up (you confirm the price first).',
          actions: ["CHECK_APP_DOMAIN"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "how much does myapp.io cost for Acme Bot?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "✔ myapp.io is available — $34.99/yr (renews at $34.99/yr).",
          actions: ["CHECK_APP_DOMAIN"],
        },
      },
    ],
  ],
};

export default checkAppDomainAction;
