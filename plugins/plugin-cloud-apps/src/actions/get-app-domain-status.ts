/**
 * Reports the live registrar, verification, and TLS state of one domain
 * attached to a published Project. It resolves the local registry binding
 * before reading Cloud and never mutates or purchases anything.
 */

import type { AppDomainStatusResponse } from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { getCloudClient, resolveCloudApiKey } from "../client.js";
import {
  domainProjectResolutionMessage,
  extractDomainReferences,
  resolveDomainTargetProject,
} from "../domain-intent.js";

const ACTION_NAME = "GET_APP_DOMAIN_STATUS";
const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can check your domain's status.";
const NO_DOMAIN_MESSAGE =
  "Which attached domain should I check? Give me the full name, e.g. yourbrand.com.";
const MANY_DOMAINS_MESSAGE =
  "I can check one attached domain at a time. Which single domain should I inspect?";
const ERROR_MESSAGE =
  "I couldn't fetch that domain's live status right now — the Cloud API returned an error. Try again in a moment.";

type CompleteDomainStatus = AppDomainStatusResponse & {
  success: true;
  domain: string;
  registrar: "external" | "cloudflare";
  status: string;
  verified: boolean;
};

function isCompleteDomainStatus(
  value: AppDomainStatusResponse,
  requestedDomain: string,
): value is CompleteDomainStatus {
  const live = value.live;
  const validLive =
    live === null ||
    live === undefined ||
    (typeof live === "object" &&
      typeof live.status === "string" &&
      (live.completedAt === null || typeof live.completedAt === "string") &&
      (live.failureReason === null || typeof live.failureReason === "string"));
  return (
    value.success === true &&
    typeof value.domain === "string" &&
    value.domain.toLowerCase() === requestedDomain &&
    (value.registrar === "external" || value.registrar === "cloudflare") &&
    typeof value.status === "string" &&
    value.status.length > 0 &&
    typeof value.verified === "boolean" &&
    (value.sslStatus === undefined ||
      value.sslStatus === null ||
      typeof value.sslStatus === "string") &&
    (value.expiresAt === undefined ||
      value.expiresAt === null ||
      typeof value.expiresAt === "string") &&
    validLive
  );
}

function formatStatus(appName: string, status: CompleteDomainStatus): string {
  const registrar =
    status.registrar === "cloudflare"
      ? "registered through Eliza Cloud"
      : "externally managed";
  const verification = status.verified ? "verified" : "not verified";
  const ssl =
    typeof status.sslStatus === "string" && status.sslStatus.length > 0
      ? `SSL ${status.sslStatus}`
      : "SSL status unavailable";
  const lines = [
    `"${appName}" domain ${status.domain}: ${status.status}, ${registrar}, ${verification}, ${ssl}.`,
  ];

  if (status.live) {
    const completed = status.live.completedAt
      ? `; completed ${status.live.completedAt}`
      : "";
    const failure = status.live.failureReason
      ? `; registrar reported: ${status.live.failureReason}`
      : "";
    lines.push(
      `Live registrar status: ${status.live.status}${completed}${failure}.`,
    );
  } else if (status.registrar === "external") {
    lines.push(
      "Live registrar polling does not apply to externally managed domains.",
    );
  } else {
    lines.push(
      "Cloud did not return a live registrar update; the stored status is shown.",
    );
  }

  if (status.expiresAt) {
    lines.push(`Registration expiry: ${status.expiresAt}.`);
  }
  return lines.join("\n");
}

export const getAppDomainStatusAction: Action = {
  name: ACTION_NAME,
  similes: [
    "CHECK_APP_DOMAIN_STATUS",
    "DOMAIN_STATUS",
    "IS_DOMAIN_ACTIVE",
    "DOMAIN_VERIFICATION_STATUS",
    "CHECK_DOMAIN_SETUP",
  ],
  description:
    "Read the current registrar, verification, and SSL status of one domain already attached to a published project, including live registrar progress for Cloud-registered domains. Use for 'did my domain get bought?', 'is it active?', or 'is it verified?'. Do not use to check whether an unowned domain is available.",
  descriptionCompressed:
    "Get one attached domain's live registrar/verification/SSL status.",
  contexts: ["settings", "apps"],
  contextGate: { anyOf: ["settings", "apps"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "domain",
      description: "The attached domain to inspect, e.g. yourbrand.com.",
      required: true,
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: [ACTION_NAME] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const domains = extractDomainReferences(message, options);
    if (domains.length === 0) {
      await callback?.({ text: NO_DOMAIN_MESSAGE, actions: [ACTION_NAME] });
      return {
        success: false,
        text: "No attached domain reference supplied.",
        userFacingText: NO_DOMAIN_MESSAGE,
        data: { reason: "no_domain" },
      };
    }
    if (domains.length > 1) {
      await callback?.({ text: MANY_DOMAINS_MESSAGE, actions: [ACTION_NAME] });
      return {
        success: false,
        text: "More than one domain reference supplied.",
        userFacingText: MANY_DOMAINS_MESSAGE,
        data: { reason: "ambiguous_domain", candidates: domains },
      };
    }
    const domain = domains[0];

    let target: Awaited<ReturnType<typeof resolveDomainTargetProject>>;
    try {
      target = await resolveDomainTargetProject(client, message, options);
    } catch (error) {
      // error-policy:J1 The action boundary translates project-resolution failures for the planner.
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "[GET_APP_DOMAIN_STATUS] failed to resolve published project",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION_NAME] });
      return {
        success: false,
        text: "Failed to resolve the published project.",
        userFacingText: ERROR_MESSAGE,
        error: error instanceof Error ? error : new Error(String(error)),
        data: { reason: "error" },
      };
    }

    if (!target.project || !target.app) {
      const reply = domainProjectResolutionMessage(target);
      await callback?.({ text: reply, actions: [ACTION_NAME] });
      return {
        success: false,
        text: "Published project could not be resolved.",
        userFacingText: reply,
        data: { reason: target.reason },
      };
    }

    const { app, project } = target;
    try {
      const status = await client.getAppDomainStatus(app.id, { domain });
      if (!isCompleteDomainStatus(status, domain)) {
        throw new ElizaError(
          "Cloud returned an incomplete or mismatched domain status",
          {
            code: "CLOUD_DOMAIN_STATUS_INVALID",
            context: { appId: app.id, requestedDomain: domain },
          },
        );
      }

      const reply = formatStatus(project.name, status);
      await callback?.({ text: reply, actions: [ACTION_NAME] });
      return {
        success: true,
        text: `Read live status for ${domain} on ${project.name}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: project.cloudAppId,
          },
          app: { id: app.id, name: app.name, slug: app.slug },
          domain: status.domain,
          registrar: status.registrar,
          status: status.status,
          verified: status.verified,
          ...(status.sslStatus !== undefined
            ? { sslStatus: status.sslStatus }
            : {}),
          ...(status.expiresAt !== undefined
            ? { expiresAt: status.expiresAt }
            : {}),
          ...(status.live !== undefined ? { live: status.live } : {}),
        },
      };
    } catch (error) {
      // error-policy:J1 The action boundary translates Cloud transport and response failures.
      logger.warn(
        {
          appId: app.id,
          domain,
          error: error instanceof Error ? error.message : String(error),
        },
        "[GET_APP_DOMAIN_STATUS] status request failed",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION_NAME] });
      return {
        success: false,
        text: "Failed to read project domain status.",
        userFacingText: ERROR_MESSAGE,
        error: error instanceof Error ? error : new Error(String(error)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "did coolbrand.com get bought for Acme Bot?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" domain coolbrand.com: active, registered through Eliza Cloud, verified, SSL active.\nLive registrar status: active; completed 2026-07-23T12:00:00.000Z.',
          actions: [ACTION_NAME],
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "is example.org verified yet?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: '"Acme Bot" domain example.org: pending, externally managed, not verified, SSL pending.\nLive registrar polling does not apply to externally managed domains.',
          actions: [ACTION_NAME],
        },
      },
    ],
  ],
};

export default getAppDomainStatusAction;
