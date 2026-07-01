/**
 * LIST_APP_DOMAINS — READ-ONLY list of the domains attached to a Cloud app.
 *
 * Wraps `GET /api/v1/apps/:id/domains` and reports each attachment's
 * registrar, status, SSL state, verification state (with the exact TXT record
 * hint for unverified external domains), and renewal date.
 */

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
import { formatDomainLine, resolveDomainTargetApp } from "../domain-intent.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can list your domains.";
const NO_APPS_MESSAGE =
  "You don't have any Cloud apps yet, so there are no domains to list.";
const ERROR_MESSAGE =
  "I couldn't fetch that app's domains right now — the Cloud API returned an error. Try again in a moment.";

function notFoundMessage(available: string[]): string {
  return `Which app's domains should I list? Your apps are: ${available.join(", ")}.`;
}

export const listAppDomainsAction: Action = {
  name: "LIST_APP_DOMAINS",
  similes: [
    "LIST_DOMAINS",
    "SHOW_DOMAINS",
    "MY_DOMAINS",
    "APP_DOMAINS",
    "WHAT_DOMAINS",
  ],
  description:
    "List the custom domains attached to an Eliza Cloud app, with registrar, status, SSL, verification state, and renewal date. Read-only. Use when the user asks what domains an app has or whether a domain is set up/verified.",
  descriptionCompressed: "List a Cloud app's attached domains (read-only).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "appName",
      description: "Name, slug, or id of the Cloud app whose domains to list.",
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    let resolved: Awaited<ReturnType<typeof resolveDomainTargetApp>>;
    try {
      resolved = await resolveDomainTargetApp(client, message, options);
    } catch (err) {
      logger.warn(
        `[LIST_APP_DOMAINS] failed to resolve app: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: "Failed to resolve the Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!resolved.app) {
      if (resolved.available.length === 0) {
        await callback?.({
          text: NO_APPS_MESSAGE,
          actions: ["LIST_APP_DOMAINS"],
        });
        return {
          success: false,
          text: "User has no Cloud apps.",
          userFacingText: NO_APPS_MESSAGE,
          data: { reason: "no_apps" },
        };
      }
      const candidates =
        resolved.ambiguous && resolved.ambiguous.length > 1
          ? resolved.ambiguous
          : resolved.available;
      const msg = resolved.ambiguous
        ? `Which app do you mean? That matches ${candidates.length}: ${candidates.join(", ")}. Reply with the exact name.`
        : notFoundMessage(candidates);
      await callback?.({ text: msg, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: resolved.ambiguous
          ? "Ambiguous app reference."
          : "No app matched the reference.",
        userFacingText: msg,
        data: {
          reason: resolved.ambiguous ? "ambiguous" : "not_found",
          candidates,
        },
      };
    }
    const app = resolved.app;

    try {
      const { domains } = await client.listAppDomains(app.id);
      const rows = domains ?? [];
      if (rows.length === 0) {
        const msg = `"${app.name}" has no custom domains yet. Say "buy yourbrand.com for ${app.name}" and I'll check the price.`;
        await callback?.({ text: msg, actions: ["LIST_APP_DOMAINS"] });
        return {
          success: true,
          text: `${app.name} has no attached domains.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: {
            app: { id: app.id, name: app.name, slug: app.slug },
            domains: [],
          },
        };
      }
      const reply = [
        `"${app.name}" has ${rows.length} domain${rows.length === 1 ? "" : "s"}:`,
        ...rows.map(formatDomainLine),
      ].join("\n");
      await callback?.({ text: reply, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: true,
        text: `Listed ${rows.length} domain(s) for ${app.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          app: { id: app.id, name: app.name, slug: app.slug },
          domains: rows.map((d) => ({
            domain: d.domain,
            registrar: d.registrar,
            status: d.status,
            verified: d.verified,
            sslStatus: d.sslStatus,
            expiresAt: d.expiresAt,
            verificationToken: d.verificationToken,
          })),
        },
      };
    } catch (err) {
      logger.warn(
        `[LIST_APP_DOMAINS] listAppDomains(${app.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: "Failed to list app domains.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "what domains does Acme Bot have?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" has 1 domain:\n• coolbrand.com — registered through Eliza Cloud, active, SSL active, renews 2027-07-01',
          actions: ["LIST_APP_DOMAINS"],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "is my custom domain verified yet?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" has 1 domain:\n• example.org — external, pending, SSL pending, needs DNS verification (add the TXT record at _eliza-cloud-verify.example.org)',
          actions: ["LIST_APP_DOMAINS"],
        },
      },
    ],
  ],
};

export default listAppDomainsAction;
