/**
 * Plans and applies the two external mutations required for the SlopHub
 * canonical-domain cutover. Targets are compiled into this operator so a
 * workflow input cannot widen its authority. Apply consumes a reviewed plan,
 * re-reads both providers, refuses drift, preserves unrelated firewall rules,
 * and proves the desired state after mutation.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const TARGET = Object.freeze({
  dnsName: "git.slop.cash",
  dnsType: "A",
  ipv4: "5.78.151.202",
  sshPort: "2222",
  zoneName: "slop.cash",
  sourceCidrs: ["0.0.0.0/0", "::/0"] as const,
});
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ACTION_POLLS = 30;
const ACTION_POLL_DELAY_MS = 2_000;

type Request = typeof fetch;
type JsonObject = Record<string, unknown>;

interface Environment {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  HCLOUD_TOKEN?: string;
  SLOPHUB_SOURCE_SHA?: string;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

interface FirewallRule {
  direction: string;
  protocol: string;
  port?: string | null;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string | null;
}

export interface SlopHubCutoverPlan {
  schemaVersion: 1;
  sourceSha: string;
  target: typeof TARGET;
  cloudflare: {
    accountId: string;
    zoneId: string;
    recordId: string | null;
    before: DnsRecord | null;
    action: "create" | "patch" | "noop";
  };
  hetzner: {
    serverId: number;
    serverName: string;
    firewallId: number;
    firewallName: string;
    beforeRules: FirewallRule[];
    beforeRulesSha256: string;
    nextRules: FirewallRule[];
    action: "add-rule" | "noop";
  };
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function requiredEnvironment(environment: Environment): Required<Environment> {
  const resolved = {
    CLOUDFLARE_ACCOUNT_ID: string(
      environment.CLOUDFLARE_ACCOUNT_ID,
      "CLOUDFLARE_ACCOUNT_ID",
    ),
    CLOUDFLARE_API_TOKEN: string(
      environment.CLOUDFLARE_API_TOKEN,
      "CLOUDFLARE_API_TOKEN",
    ),
    HCLOUD_TOKEN: string(environment.HCLOUD_TOKEN, "HCLOUD_TOKEN"),
    SLOPHUB_SOURCE_SHA: string(
      environment.SLOPHUB_SOURCE_SHA,
      "SLOPHUB_SOURCE_SHA",
    ),
  };
  if (!SOURCE_SHA.test(resolved.SLOPHUB_SOURCE_SHA)) {
    throw new TypeError(
      "SLOPHUB_SOURCE_SHA must be a full lowercase commit SHA",
    );
  }
  return resolved;
}

async function jsonResponse(
  response: Response,
  boundary: string,
): Promise<JsonObject> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new RangeError(`${boundary} response exceeds its byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    // error-policy:J2 context-adding rethrow — provider bodies are untrusted and
    // may contain credentials or internal detail, so never echo them.
    throw new Error(`${boundary} returned invalid JSON`, { cause: error });
  }
  if (!response.ok)
    throw new Error(`${boundary} returned HTTP ${response.status}`);
  return object(value, `${boundary} response`);
}

async function cloudflareRequest(
  path: string,
  environment: Required<Environment>,
  request: Request,
  init: RequestInit = {},
): Promise<unknown> {
  // The shared application helper owns normal API calls. This operator keeps a
  // separate injected-fetch boundary because plans must be statefully tested,
  // provider responses are byte-bounded, and errors must never echo bodies.
  const response = await request(
    `https://api.cloudflare.com/client/v4${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
  const envelope = await jsonResponse(response, "Cloudflare API");
  if (envelope.success !== true)
    throw new Error("Cloudflare API reported failure");
  return envelope.result;
}

async function hetznerRequest(
  path: string,
  environment: Required<Environment>,
  request: Request,
  init: RequestInit = {},
): Promise<JsonObject> {
  const response = await request(`https://api.hetzner.cloud/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${environment.HCLOUD_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  return jsonResponse(response, "Hetzner API");
}

async function listHetzner(
  path: string,
  field: string,
  environment: Required<Environment>,
  request: Request,
): Promise<unknown[]> {
  const values: unknown[] = [];
  let terminalPage: number | null = null;
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await hetznerRequest(
      `${path}${separator}page=${page}&per_page=50`,
      environment,
      request,
    );
    values.push(...array(response[field], `Hetzner ${field}`));
    const pagination = object(
      object(response.meta, "Hetzner meta").pagination,
      "pagination",
    );
    const lastPage = integer(pagination.last_page, "pagination.last_page");
    if (lastPage < page) {
      throw new RangeError(
        `Hetzner ${field} returned invalid pagination metadata`,
      );
    }
    terminalPage ??= lastPage;
    if (lastPage !== terminalPage) {
      throw new RangeError(
        `Hetzner ${field} changed its terminal page during traversal`,
      );
    }
    if (page >= terminalPage) return values;
  }
}

function parseDnsRecord(value: unknown): DnsRecord {
  const record = object(value, "Cloudflare DNS record");
  const proxied = record.proxied;
  const ttl = record.ttl;
  if (
    typeof proxied !== "boolean" ||
    !Number.isSafeInteger(ttl) ||
    (ttl as number) < 1
  ) {
    throw new TypeError(
      "Cloudflare DNS record has invalid proxied or ttl fields",
    );
  }
  return {
    id: string(record.id, "DNS record id"),
    type: string(record.type, "DNS record type"),
    name: string(record.name, "DNS record name"),
    content: string(record.content, "DNS record content"),
    proxied,
    ttl: ttl as number,
  };
}

function parseFirewallRule(value: unknown): FirewallRule {
  const rule = object(value, "Hetzner firewall rule");
  const parsed: FirewallRule = {
    direction: string(rule.direction, "firewall rule direction"),
    protocol: string(rule.protocol, "firewall rule protocol"),
  };
  if (rule.port !== undefined && rule.port !== null) {
    parsed.port = string(rule.port, "firewall rule port");
  }
  for (const field of ["source_ips", "destination_ips"] as const) {
    if (rule[field] !== undefined) {
      parsed[field] = array(rule[field], `firewall rule ${field}`).map(
        (value) => string(value, `firewall rule ${field} entry`),
      );
    }
  }
  if (rule.description !== undefined && rule.description !== null) {
    parsed.description = string(rule.description, "firewall rule description");
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function firewallRulesSha256(rules: FirewallRule[]): string {
  return sha256(rules.map(canonicalJson).sort());
}

function desiredSshRule(): FirewallRule {
  return {
    direction: "in",
    protocol: "tcp",
    port: TARGET.sshPort,
    source_ips: [...TARGET.sourceCidrs],
    description: "Public SlopHub Forgejo SSH",
  };
}

function isDesiredSshRule(rule: FirewallRule): boolean {
  return (
    rule.direction === "in" &&
    rule.protocol === "tcp" &&
    rule.port === TARGET.sshPort &&
    canonicalJson([...(rule.source_ips ?? [])].sort()) ===
      canonicalJson([...TARGET.sourceCidrs].sort())
  );
}

export async function buildSlopHubCutoverPlan(
  rawEnvironment: Environment,
  request: Request = fetch,
): Promise<SlopHubCutoverPlan> {
  const environment = requiredEnvironment(rawEnvironment);
  const zones = array(
    await cloudflareRequest(
      `/zones?name=${encodeURIComponent(TARGET.zoneName)}&status=active&per_page=50`,
      environment,
      request,
    ),
    "Cloudflare zones",
  )
    .map((value) => object(value, "Cloudflare zone"))
    .filter(
      (zone) =>
        zone.name === TARGET.zoneName &&
        object(zone.account, "Cloudflare zone account").id ===
          environment.CLOUDFLARE_ACCOUNT_ID,
    );
  if (zones.length !== 1) {
    throw new Error(
      `Expected exactly one active ${TARGET.zoneName} zone in the configured account`,
    );
  }
  const zoneId = string(zones[0]?.id, "Cloudflare zone id");
  const records = array(
    await cloudflareRequest(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?name.exact=${encodeURIComponent(TARGET.dnsName)}&per_page=100`,
      environment,
      request,
    ),
    "Cloudflare DNS records",
  ).map(parseDnsRecord);
  if (
    records.length > 1 ||
    records.some(
      (record) =>
        record.type !== TARGET.dnsType || record.name !== TARGET.dnsName,
    )
  ) {
    throw new Error(
      `Expected zero or one A record and no conflicting record at ${TARGET.dnsName}`,
    );
  }
  const record = records[0] ?? null;
  const dnsAction = !record
    ? "create"
    : record.content === TARGET.ipv4 && record.proxied === false
      ? "noop"
      : "patch";

  const servers = (
    await listHetzner("/servers", "servers", environment, request)
  )
    .map((value) => object(value, "Hetzner server"))
    .filter((server) => {
      const publicNet = object(server.public_net, "Hetzner server public_net");
      const ipv4 = object(publicNet.ipv4, "Hetzner server IPv4");
      return ipv4.ip === TARGET.ipv4;
    });
  if (servers.length !== 1) {
    throw new Error(
      `Expected exactly one Hetzner server with IPv4 ${TARGET.ipv4}`,
    );
  }
  const server = servers[0] as JsonObject;
  const serverId = integer(server.id, "Hetzner server id");
  const firewalls = (
    await listHetzner("/firewalls", "firewalls", environment, request)
  )
    .map((value) => object(value, "Hetzner firewall"))
    .filter((firewall) => {
      const targets = array(firewall.applied_to, "Hetzner firewall applied_to");
      if (targets.length !== 1) return false;
      const applied = object(targets[0], "Hetzner firewall target");
      return (
        applied.type === "server" &&
        integer(
          object(applied.server, "Hetzner firewall server").id,
          "firewall server id",
        ) === serverId
      );
    });
  if (firewalls.length !== 1) {
    throw new Error(
      `Expected exactly one Hetzner firewall applied to server ${serverId}`,
    );
  }
  const firewall = firewalls[0] as JsonObject;
  const beforeRules = array(firewall.rules, "Hetzner firewall rules").map(
    parseFirewallRule,
  );
  const hasSshRule = beforeRules.some(isDesiredSshRule);
  const nextRules = hasSshRule
    ? beforeRules
    : [...beforeRules, desiredSshRule()];

  return {
    schemaVersion: 1,
    sourceSha: environment.SLOPHUB_SOURCE_SHA,
    target: TARGET,
    cloudflare: {
      accountId: environment.CLOUDFLARE_ACCOUNT_ID,
      zoneId,
      recordId: record?.id ?? null,
      before: record,
      action: dnsAction,
    },
    hetzner: {
      serverId,
      serverName: string(server.name, "Hetzner server name"),
      firewallId: integer(firewall.id, "Hetzner firewall id"),
      firewallName: string(firewall.name, "Hetzner firewall name"),
      beforeRules,
      beforeRulesSha256: firewallRulesSha256(beforeRules),
      nextRules,
      action: hasSshRule ? "noop" : "add-rule",
    },
  };
}

function validateReviewedPlan(
  value: unknown,
  expectedSourceSha: string,
): SlopHubCutoverPlan {
  const plan = object(
    value,
    "reviewed SlopHub plan",
  ) as unknown as SlopHubCutoverPlan;
  const beforeRules = array(
    plan.hetzner?.beforeRules,
    "reviewed beforeRules",
  ).map(parseFirewallRule);
  const nextRules = array(plan.hetzner?.nextRules, "reviewed nextRules").map(
    parseFirewallRule,
  );
  const action = plan.hetzner?.action;
  const rulesAreValid =
    plan.hetzner.beforeRulesSha256 === firewallRulesSha256(beforeRules) &&
    (action === "add-rule"
      ? firewallRulesSha256(nextRules) ===
        firewallRulesSha256([...beforeRules, desiredSshRule()])
      : action === "noop" &&
        beforeRules.some(isDesiredSshRule) &&
        firewallRulesSha256(nextRules) === firewallRulesSha256(beforeRules));
  if (
    plan.schemaVersion !== 1 ||
    plan.sourceSha !== expectedSourceSha ||
    canonicalJson(plan.target) !== canonicalJson(TARGET) ||
    !["create", "patch", "noop"].includes(plan.cloudflare?.action) ||
    !["add-rule", "noop"].includes(action) ||
    !rulesAreValid
  ) {
    throw new Error("Reviewed SlopHub plan failed schema or source validation");
  }
  return plan;
}

function assertNoDrift(
  reviewed: SlopHubCutoverPlan,
  current: SlopHubCutoverPlan,
): void {
  if (canonicalJson(reviewed.target) !== canonicalJson(current.target)) {
    throw new Error("SlopHub target changed after plan review");
  }
  if (current.cloudflare.action !== "noop") {
    if (
      reviewed.cloudflare.action !== current.cloudflare.action ||
      reviewed.cloudflare.zoneId !== current.cloudflare.zoneId ||
      reviewed.cloudflare.recordId !== current.cloudflare.recordId ||
      canonicalJson(reviewed.cloudflare.before) !==
        canonicalJson(current.cloudflare.before)
    ) {
      throw new Error("Cloudflare DNS state drifted after plan review");
    }
  }
  if (current.hetzner.action !== "noop") {
    if (
      reviewed.hetzner.action !== current.hetzner.action ||
      reviewed.hetzner.serverId !== current.hetzner.serverId ||
      reviewed.hetzner.firewallId !== current.hetzner.firewallId ||
      reviewed.hetzner.beforeRulesSha256 !== current.hetzner.beforeRulesSha256
    ) {
      throw new Error("Hetzner firewall state drifted after plan review");
    }
  }
}

function validateDnsMutation(
  value: unknown,
  expectedRecordId: string | null,
): void {
  const record = parseDnsRecord(value);
  if (
    record.type !== TARGET.dnsType ||
    record.name !== TARGET.dnsName ||
    record.content !== TARGET.ipv4 ||
    record.proxied !== false ||
    (expectedRecordId !== null && record.id !== expectedRecordId)
  ) {
    throw new Error("Cloudflare DNS mutation returned an unexpected record");
  }
}

async function waitForHetznerAction(
  initialResponse: JsonObject,
  environment: Required<Environment>,
  request: Request,
): Promise<void> {
  const actions = array(initialResponse.actions, "Hetzner actions");
  if (actions.length !== 1) {
    throw new Error("Hetzner set_rules must return exactly one action");
  }
  let action = object(actions[0], "Hetzner action");
  const actionId = integer(action.id, "Hetzner action id");
  for (let poll = 0; poll <= MAX_ACTION_POLLS; poll += 1) {
    const status = string(action.status, "Hetzner action status");
    if (status === "success") return;
    if (status === "error")
      throw new Error(`Hetzner action ${actionId} failed`);
    if (status !== "running") {
      throw new Error(
        `Hetzner action ${actionId} returned an unsupported status`,
      );
    }
    if (poll === MAX_ACTION_POLLS) {
      throw new Error(
        `Hetzner action ${actionId} did not finish before the poll limit`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ACTION_POLL_DELAY_MS));
    const response = await hetznerRequest(
      `/actions/${actionId}`,
      environment,
      request,
    );
    action = object(response.action, "Hetzner action");
    if (integer(action.id, "Hetzner action id") !== actionId) {
      throw new Error("Hetzner action identity changed while polling");
    }
  }
}

export async function applySlopHubCutoverPlan(
  rawPlan: unknown,
  rawEnvironment: Environment,
  request: Request = fetch,
): Promise<SlopHubCutoverPlan> {
  const environment = requiredEnvironment(rawEnvironment);
  const reviewed = validateReviewedPlan(
    rawPlan,
    environment.SLOPHUB_SOURCE_SHA,
  );
  const current = await buildSlopHubCutoverPlan(environment, request);
  assertNoDrift(reviewed, current);

  // Ingress must be proven ready before the public hostname can expose it.
  if (current.hetzner.action === "add-rule") {
    const action = await hetznerRequest(
      `/firewalls/${current.hetzner.firewallId}/actions/set_rules`,
      environment,
      request,
      {
        method: "POST",
        body: JSON.stringify({ rules: current.hetzner.nextRules }),
      },
    );
    await waitForHetznerAction(action, environment, request);

    const ingressVerified = await buildSlopHubCutoverPlan(environment, request);
    if (
      ingressVerified.hetzner.action !== "noop" ||
      ingressVerified.hetzner.serverId !== current.hetzner.serverId ||
      ingressVerified.hetzner.firewallId !== current.hetzner.firewallId ||
      ingressVerified.hetzner.beforeRulesSha256 !==
        firewallRulesSha256(current.hetzner.nextRules) ||
      ingressVerified.cloudflare.action !== current.cloudflare.action ||
      ingressVerified.cloudflare.zoneId !== current.cloudflare.zoneId ||
      ingressVerified.cloudflare.recordId !== current.cloudflare.recordId ||
      canonicalJson(ingressVerified.cloudflare.before) !==
        canonicalJson(current.cloudflare.before)
    ) {
      throw new Error(
        "SlopHub ingress did not match the reviewed state before DNS cutover",
      );
    }
  }

  if (current.cloudflare.action === "create") {
    const created = await cloudflareRequest(
      `/zones/${encodeURIComponent(current.cloudflare.zoneId)}/dns_records`,
      environment,
      request,
      {
        method: "POST",
        body: JSON.stringify({
          type: TARGET.dnsType,
          name: TARGET.dnsName,
          content: TARGET.ipv4,
          proxied: false,
          ttl: 1,
        }),
      },
    );
    validateDnsMutation(created, null);
  } else if (current.cloudflare.action === "patch") {
    const patched = await cloudflareRequest(
      `/zones/${encodeURIComponent(current.cloudflare.zoneId)}/dns_records/${encodeURIComponent(
        string(current.cloudflare.recordId, "Cloudflare record id"),
      )}`,
      environment,
      request,
      {
        method: "PATCH",
        body: JSON.stringify({ content: TARGET.ipv4, proxied: false }),
      },
    );
    validateDnsMutation(patched, current.cloudflare.recordId);
  }

  const verified = await buildSlopHubCutoverPlan(environment, request);
  if (
    verified.cloudflare.action !== "noop" ||
    verified.hetzner.action !== "noop" ||
    verified.cloudflare.zoneId !== current.cloudflare.zoneId ||
    verified.hetzner.serverId !== current.hetzner.serverId ||
    verified.hetzner.firewallId !== current.hetzner.firewallId ||
    verified.hetzner.beforeRulesSha256 !==
      firewallRulesSha256(current.hetzner.nextRules)
  ) {
    throw new Error(
      "SlopHub cutover apply did not converge to the reviewed desired state",
    );
  }
  return verified;
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: "string" },
      plan: { type: "string" },
    },
  });
  const action = parsed.positionals[0];
  if (
    parsed.positionals.length !== 1 ||
    (action !== "plan" && action !== "apply")
  ) {
    throw new Error(
      "usage: slophub-cutover.ts plan --output <path> | apply --plan <path>",
    );
  }
  if (action === "plan") {
    if (!parsed.values.output || parsed.values.plan) {
      throw new Error("plan requires --output and rejects --plan");
    }
    const plan = await buildSlopHubCutoverPlan(process.env);
    writeFileSync(parsed.values.output, `${JSON.stringify(plan, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        action: "plan",
        dns: plan.cloudflare.action,
        firewall: plan.hetzner.action,
        zoneId: plan.cloudflare.zoneId,
        serverId: plan.hetzner.serverId,
        firewallId: plan.hetzner.firewallId,
      }),
    );
    return;
  }
  if (!parsed.values.plan || parsed.values.output) {
    throw new Error("apply requires --plan and rejects --output");
  }
  const reviewed = JSON.parse(
    readFileSync(parsed.values.plan, "utf8"),
  ) as unknown;
  const verified = await applySlopHubCutoverPlan(reviewed, process.env);
  console.log(
    JSON.stringify({
      action: "apply",
      dns: verified.cloudflare.action,
      firewall: verified.hetzner.action,
      zoneId: verified.cloudflare.zoneId,
      recordId: verified.cloudflare.recordId,
      serverId: verified.hetzner.serverId,
      firewallId: verified.hetzner.firewallId,
    }),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // error-policy:J1 CLI boundary translation — one redacted message and a
    // non-zero exit are the complete operator failure contract.
    console.error(
      error instanceof Error ? error.message : "SlopHub cutover failed",
    );
    process.exitCode = 1;
  });
}
