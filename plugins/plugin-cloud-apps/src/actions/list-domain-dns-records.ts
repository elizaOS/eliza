/**
 * Lists public DNS records for one Eliza Cloud-managed project domain.
 *
 * Project resolution is ambiguity-safe and the Cloud route enforces that the
 * domain is attached to its bound app and registered through Cloudflare.
 */

import type { DomainDnsRecordDto } from "@elizaos/cloud-sdk";
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
  cloudErrorInfo,
  domainProjectResolutionMessage,
  extractDomainReferences,
  resolveDomainTargetProject,
} from "../domain-intent.js";

const ACTION = "LIST_DOMAIN_DNS_RECORDS";
const NO_KEY_MESSAGE =
  "Connect Eliza Cloud before listing managed DNS records.";
const NO_DOMAIN_MESSAGE =
  "Which managed domain should I inspect? Give me one full domain name.";
const MANY_DOMAINS_MESSAGE =
  "I can list DNS records for one domain at a time. Which domain should I inspect?";
const ERROR_MESSAGE =
  "I couldn't load that domain's DNS records right now. Try again in a moment.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDnsRecord(record: unknown): record is DomainDnsRecordDto {
  if (!isRecord(record)) return false;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.type === "string" &&
    record.type.length > 0 &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof record.content === "string" &&
    record.content.length > 0 &&
    typeof record.ttl === "number" &&
    Number.isInteger(record.ttl) &&
    record.ttl >= 1 &&
    typeof record.proxied === "boolean" &&
    (record.priority === undefined ||
      (typeof record.priority === "number" &&
        Number.isInteger(record.priority) &&
        record.priority >= 0)) &&
    (record.createdOn === undefined || typeof record.createdOn === "string") &&
    (record.modifiedOn === undefined || typeof record.modifiedOn === "string")
  );
}

function assertDnsResponse(
  response: unknown,
  requestedDomain: string,
): DomainDnsRecordDto[] {
  if (
    !isRecord(response) ||
    response.success !== true ||
    typeof response.domain !== "string" ||
    response.domain.toLowerCase() !== requestedDomain ||
    !Array.isArray(response.records) ||
    !response.records.every(isDnsRecord)
  ) {
    throw new ElizaError("Cloud returned an invalid DNS-record response", {
      code: "CLOUD_DOMAIN_DNS_INVALID",
      context: { requestedDomain },
      severity: "fatal",
    });
  }
  return response.records;
}

function ttlLabel(ttl: number): string {
  return ttl === 1 ? "automatic TTL" : `TTL ${ttl}s`;
}

function recordLine(record: DomainDnsRecordDto): string {
  const details = [
    ttlLabel(record.ttl),
    record.proxied ? "proxied" : "DNS only",
  ];
  if (record.priority !== undefined) {
    details.push(`priority ${record.priority}`);
  }
  return `• ${record.type} ${record.name} → ${record.content} — ${details.join(", ")}`;
}

export const listDomainDnsRecordsAction: Action = {
  name: ACTION,
  similes: ["GET_DOMAIN_DNS_RECORDS", "SHOW_DNS_RECORDS", "LIST_DNS_RECORDS"],
  description:
    "List the public DNS records for one Cloudflare-managed domain attached to a published project. Read-only. External domains must be inspected at their existing DNS provider.",
  descriptionCompressed:
    "List one managed project domain's public DNS records.",
  contexts: ["settings", "projects"],
  contextGate: { anyOf: ["settings", "projects"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "domain",
      description: "The managed domain to inspect, e.g. habit.tools.",
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
      await callback?.({ text: NO_KEY_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const domains = extractDomainReferences(message, options);
    if (domains.length === 0) {
      await callback?.({ text: NO_DOMAIN_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "No managed domain reference supplied.",
        userFacingText: NO_DOMAIN_MESSAGE,
        data: { reason: "no_domain" },
      };
    }
    if (domains.length > 1) {
      await callback?.({ text: MANY_DOMAINS_MESSAGE, actions: [ACTION] });
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
      // error-policy:J1 The action boundary translates project-resolution failures.
      logger.error(
        { error, domain },
        "[LIST_DOMAIN_DNS_RECORDS] Published-project resolution failed",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION] });
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
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: false,
        text: "Published project could not be resolved.",
        userFacingText: reply,
        data: { reason: target.reason },
      };
    }

    const { app, project } = target;
    try {
      const records = assertDnsResponse(
        await client.listAppDomainDnsRecords(app.id, domain),
        domain,
      );
      if (records.length === 0) {
        const reply = `${domain} on “${project.name}” has no DNS records.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: `No DNS records found for ${domain}.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            project: {
              id: project.id,
              name: project.name,
              cloudAppId: project.cloudAppId,
            },
            app: { id: app.id, name: app.name, slug: app.slug },
            domain,
            records: [],
          },
        };
      }

      const reply = [
        `DNS records for ${domain} on “${project.name}”:`,
        ...records.map(recordLine),
      ].join("\n");
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Listed ${records.length} DNS record(s) for ${domain}.`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          project: {
            id: project.id,
            name: project.name,
            cloudAppId: project.cloudAppId,
          },
          app: { id: app.id, name: app.name, slug: app.slug },
          domain,
          records,
        },
      };
    } catch (error) {
      // error-policy:J1 action boundary translates expected Cloud failures.
      const info = cloudErrorInfo(error);
      const reply =
        info.status === 409
          ? `${domain} uses an external DNS provider. Manage its DNS records there.`
          : info.status === 404
            ? `${domain} is not attached to “${project.name}”.`
            : ERROR_MESSAGE;
      const reason =
        info.status === 409
          ? "external_dns_provider"
          : info.status === 404
            ? "not_attached"
            : "error";
      logger.error(
        { error, appId: app.id, domain, reason },
        "[LIST_DOMAIN_DNS_RECORDS] DNS record read failed",
      );
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: false,
        text: "DNS record read failed.",
        userFacingText: reply,
        error: error instanceof Error ? error : new Error(String(error)),
        data: { reason },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "show the DNS records for habit.tools" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "DNS records for habit.tools on “Habit Tracker”:\n• A habit.tools → 192.0.2.10 — automatic TTL, proxied",
          actions: [ACTION],
        },
      },
    ],
  ],
};

export default listDomainDnsRecordsAction;
