/**
 * Lists custom domains attached to a published Project.
 *
 * The local registry resolves Project → cloudAppId before the app-scoped Cloud
 * read. Replies report registrar, SSL, verification, and renewal state without
 * treating unrelated Cloud apps as creator projects.
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
import {
  domainProjectResolutionMessage,
  formatDomainLine,
  resolveDomainTargetProject,
} from "../domain-intent.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can list your domains.";
const ERROR_MESSAGE =
  "I couldn't fetch that project's domains right now — the Cloud API returned an error. Try again in a moment.";

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
    "List the custom domains attached to a published project, with registrar, status, SSL, verification state, and renewal date. Read-only. Use when the user asks what domains a project has or whether a domain is set up/verified.",
  descriptionCompressed:
    "List a published project's attached domains (read-only).",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    let target: Awaited<ReturnType<typeof resolveDomainTargetProject>>;
    try {
      target = await resolveDomainTargetProject(client, message, options);
    } catch (err) {
      // error-policy:J1 The action boundary translates project and Cloud failures for the planner.
      logger.warn(
        `[LIST_APP_DOMAINS] failed to resolve published project: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: "Failed to resolve the published project.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }

    if (!target.project || !target.app) {
      const reply = domainProjectResolutionMessage(target);
      await callback?.({ text: reply, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: "Published project could not be resolved.",
        userFacingText: reply,
        data: { reason: target.reason },
      };
    }
    const { app, project } = target;

    try {
      const { domains } = await client.listAppDomains(app.id);
      const rows = domains;
      if (rows.length === 0) {
        const msg = `"${project.name}" has no custom domains yet. Say "buy yourbrand.com for ${project.name}" and I'll check the price.`;
        await callback?.({ text: msg, actions: ["LIST_APP_DOMAINS"] });
        return {
          success: true,
          text: `${project.name} has no attached domains.`,
          userFacingText: msg,
          verifiedUserFacing: true,
          data: {
            project: {
              id: project.id,
              name: project.name,
              cloudAppId: project.cloudAppId,
            },
            app: { id: app.id, name: app.name, slug: app.slug },
            domains: [],
          },
        };
      }
      const reply = [
        `"${project.name}" has ${rows.length} domain${rows.length === 1 ? "" : "s"}:`,
        ...rows.map(formatDomainLine),
      ].join("\n");
      await callback?.({ text: reply, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: true,
        text: `Listed ${rows.length} domain(s) for ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: project.cloudAppId,
          },
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
      // error-policy:J1 The action boundary translates Cloud transport failures for the planner.
      logger.warn(
        `[LIST_APP_DOMAINS] listAppDomains(${app.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["LIST_APP_DOMAINS"] });
      return {
        success: false,
        text: "Failed to list project domains.",
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
