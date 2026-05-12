/**
 * Cloudflare DNS Service
 *
 * Manages DNS records inside a cloudflare-owned zone (for domains we
 * registered through the registrar broker; external-attached domains
 * keep their DNS at the user's existing provider and are not editable
 * here).
 */

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { cloudflareApiRequest } from "@/lib/utils/cloudflare-api";
import { logger } from "@/lib/utils/logger";

/** Read at call time so per-request Cloudflare Worker bindings are visible. */
function config() {
  const env = getCloudAwareEnv();
  return {
    apiToken: env.CLOUDFLARE_API_TOKEN ?? "",
    devStub: env.ELIZA_CF_REGISTRAR_DEV_STUB === "1",
  };
}

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "SRV" | "CAA";

export interface DnsRecordInput {
  type: DnsRecordType;
  /** Record name. Use "@" for the zone apex; fully-qualified for subdomains. */
  name: string;
  content: string;
  /** TTL in seconds. 1 means "automatic" in cloudflare. */
  ttl?: number;
  /** Whether to proxy through cloudflare's edge (orange cloud). */
  proxied?: boolean;
  /** MX records only. */
  priority?: number;
}

export type DnsRecordPatch = Partial<Omit<DnsRecordInput, "type">> & {
  type?: DnsRecordType;
};

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
  createdOn?: string;
  modifiedOn?: string;
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
  created_on?: string;
  modified_on?: string;
}

function ensureConfigured(c: { apiToken: string; devStub: boolean }): void {
  if (c.devStub) return;
  if (!c.apiToken) {
    throw new Error(
      "Cloudflare DNS is not configured: set CLOUDFLARE_API_TOKEN, or ELIZA_CF_REGISTRAR_DEV_STUB=1 for local dev.",
    );
  }
}

function fromCf(rec: CfDnsRecord): DnsRecord {
  return {
    id: rec.id,
    type: rec.type,
    name: rec.name,
    content: rec.content,
    ttl: rec.ttl,
    proxied: rec.proxied,
    priority: rec.priority,
    createdOn: rec.created_on,
    modifiedOn: rec.modified_on,
  };
}

function buildCfBody(input: DnsRecordInput | DnsRecordPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.type !== undefined) body.type = input.type;
  if (input.name !== undefined) body.name = input.name;
  if (input.content !== undefined) body.content = input.content;
  if (input.ttl !== undefined) body.ttl = input.ttl;
  if (input.proxied !== undefined) body.proxied = input.proxied;
  if (input.priority !== undefined) body.priority = input.priority;
  return body;
}

function stubRecord(zoneId: string, input: DnsRecordInput, idHint?: string): DnsRecord {
  return {
    id: idHint ?? `stub-record-${input.type}-${input.name}`,
    type: input.type,
    name: input.name,
    content: input.content,
    ttl: input.ttl ?? 1,
    proxied: input.proxied ?? false,
    priority: input.priority,
  };
}

export async function createRecord(zoneId: string, input: DnsRecordInput): Promise<DnsRecord> {
  const cfg = config();
  ensureConfigured(cfg);
  if (cfg.devStub) {
    logger.info("[Cloudflare DNS:STUB] createRecord", { zoneId, ...input });
    return stubRecord(zoneId, input);
  }
  const cf = await cloudflareApiRequest<CfDnsRecord>(`/zones/${zoneId}/dns_records`, cfg.apiToken, {
    method: "POST",
    body: JSON.stringify({
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: input.ttl ?? 1,
      proxied: input.proxied ?? false,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    }),
  });
  return fromCf(cf);
}

export async function listRecords(zoneId: string): Promise<DnsRecord[]> {
  const cfg = config();
  ensureConfigured(cfg);
  if (cfg.devStub) {
    logger.info("[Cloudflare DNS:STUB] listRecords", { zoneId });
    return [];
  }
  const cf = await cloudflareApiRequest<CfDnsRecord[]>(
    `/zones/${zoneId}/dns_records?per_page=200`,
    cfg.apiToken,
  );
  return cf.map(fromCf);
}

export async function getRecord(zoneId: string, recordId: string): Promise<DnsRecord> {
  const cfg = config();
  ensureConfigured(cfg);
  if (cfg.devStub) {
    logger.info("[Cloudflare DNS:STUB] getRecord", { zoneId, recordId });
    return {
      id: recordId,
      type: "A",
      name: "stub.example.com",
      content: "127.0.0.1",
      ttl: 1,
      proxied: false,
    };
  }
  const cf = await cloudflareApiRequest<CfDnsRecord>(
    `/zones/${zoneId}/dns_records/${recordId}`,
    cfg.apiToken,
  );
  return fromCf(cf);
}

export async function updateRecord(
  zoneId: string,
  recordId: string,
  patch: DnsRecordPatch,
): Promise<DnsRecord> {
  const cfg = config();
  ensureConfigured(cfg);
  if (cfg.devStub) {
    logger.info("[Cloudflare DNS:STUB] updateRecord", { zoneId, recordId, ...patch });
    return {
      id: recordId,
      type: patch.type ?? "A",
      name: patch.name ?? "stub.example.com",
      content: patch.content ?? "127.0.0.1",
      ttl: patch.ttl ?? 1,
      proxied: patch.proxied ?? false,
      priority: patch.priority,
    };
  }
  const cf = await cloudflareApiRequest<CfDnsRecord>(
    `/zones/${zoneId}/dns_records/${recordId}`,
    cfg.apiToken,
    {
      method: "PATCH",
      body: JSON.stringify(buildCfBody(patch)),
    },
  );
  return fromCf(cf);
}

export async function deleteRecord(zoneId: string, recordId: string): Promise<void> {
  const cfg = config();
  ensureConfigured(cfg);
  if (cfg.devStub) {
    logger.info("[Cloudflare DNS:STUB] deleteRecord", { zoneId, recordId });
    return;
  }
  await cloudflareApiRequest<{ id: string }>(
    `/zones/${zoneId}/dns_records/${recordId}`,
    cfg.apiToken,
    { method: "DELETE" },
  );
}

export const cloudflareDnsService = {
  createRecord,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
};
