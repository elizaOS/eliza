import type {
  HandlerCallback,
  IAgentRuntime,
  Logger,
  Memory,
} from "@elizaos/core";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.js";
import type { SessionInfo } from "./pty-types.js";

const LOG_PREFIX = "[ParentAgentBroker]";
const REQUEST_MAX_CHARS = 4000;
const ACTION_LIST_LIMIT_DEFAULT = 60;
const ACTION_LIST_LIMIT_MAX = 200;
const CLOUD_RESPONSE_MAX_CHARS = 8000;
const DEFAULT_CLOUD_BASE_URL = "https://www.elizacloud.ai";

export const PARENT_AGENT_BROKER_SLUG = "parent-agent";

export const PARENT_AGENT_BROKER_MANIFEST_ENTRY = {
  slug: PARENT_AGENT_BROKER_SLUG,
  name: "Parent Eliza Agent",
  description:
    "Task-scoped bridge for asking the running parent Eliza agent to use its loaded capabilities, actions, providers, connectors, and confirmation flow.",
  guidance:
    'Use when workspace context is not enough and the parent agent should do something with its own capabilities. Examples: `USE_SKILL parent-agent {"request":"Find the next free 30 minute slot on my calendar"}`, `USE_SKILL parent-agent {"mode":"list-actions","query":"github"}`, `USE_SKILL parent-agent {"mode":"list-cloud-commands"}`, or `USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.list"}`. Mutating, paid, or destructive Cloud commands require explicit `confirmed:true` after parent/user approval.',
} as const;

type ParentAgentMode =
  | "ask"
  | "list-actions"
  | "list-cloud-commands"
  | "cloud-command";

type CloudCommandRisk =
  | "read"
  | "dry-run"
  | "mutating"
  | "paid"
  | "destructive";

interface CloudCommandDefinition {
  command: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  pathParams?: string[];
  risk: CloudCommandRisk;
}

interface ParentAgentBrokerArgs {
  mode: ParentAgentMode;
  request?: string;
  query?: string;
  limit: number;
  command?: string;
  params?: Record<string, unknown>;
  confirmed: boolean;
}

interface RuntimeWithActions {
  actions?: Array<{
    name?: string;
    description?: string;
    descriptionCompressed?: string;
    compressedDescription?: string;
    similes?: string[];
    tags?: string[];
    mode?: string;
  }>;
}

const CLOUD_COMMANDS: CloudCommandDefinition[] = [
  {
    command: "cloud.health",
    description: "Check Eliza Cloud service health.",
    method: "GET",
    path: "/api/health",
    risk: "read",
  },
  {
    command: "user.get",
    description: "Fetch the authenticated Cloud user/account context.",
    method: "GET",
    path: "/api/v1/user",
    risk: "read",
  },
  {
    command: "credits.balance",
    description: "Fetch the authenticated account credit balance.",
    method: "GET",
    path: "/api/v1/credits/balance",
    risk: "read",
  },
  {
    command: "credits.summary",
    description: "Fetch credit summary and recent accounting state.",
    method: "GET",
    path: "/api/v1/credits/summary",
    risk: "read",
  },
  {
    command: "apps.list",
    description: "List Cloud apps for the authenticated organization.",
    method: "GET",
    path: "/api/v1/apps",
    risk: "read",
  },
  {
    command: "apps.get",
    description: "Fetch a Cloud app by app id.",
    method: "GET",
    path: "/api/v1/apps/{id}",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "apps.create",
    description: "Create a Cloud app.",
    method: "POST",
    path: "/api/v1/apps",
    risk: "mutating",
  },
  {
    command: "apps.update",
    description: "Update Cloud app metadata or configuration.",
    method: "PATCH",
    path: "/api/v1/apps/{id}",
    pathParams: ["id"],
    risk: "mutating",
  },
  {
    command: "apps.delete",
    description: "Delete a Cloud app.",
    method: "DELETE",
    path: "/api/v1/apps/{id}",
    pathParams: ["id"],
    risk: "destructive",
  },
  {
    command: "apps.analytics.get",
    description: "Read aggregate analytics for a Cloud app.",
    method: "GET",
    path: "/api/v1/apps/{id}/analytics",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "apps.analytics.requests",
    description: "Read request-level analytics for a Cloud app.",
    method: "GET",
    path: "/api/v1/apps/{id}/analytics/requests",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "apps.users.list",
    description: "List users linked to a Cloud app.",
    method: "GET",
    path: "/api/v1/apps/{id}/users",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "apps.apiKey.regenerate",
    description: "Regenerate a Cloud app owner API key.",
    method: "POST",
    path: "/api/v1/apps/{id}/regenerate-api-key",
    pathParams: ["id"],
    risk: "destructive",
  },
  {
    command: "apps.monetization.get",
    description: "Read app monetization settings.",
    method: "GET",
    path: "/api/v1/apps/{id}/monetization",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "apps.monetization.update",
    description: "Set app monetization, inference markup, and purchase share.",
    method: "PUT",
    path: "/api/v1/apps/{id}/monetization",
    pathParams: ["id"],
    risk: "mutating",
  },
  {
    command: "apps.charges.list",
    description: "List arbitrary app charge requests.",
    method: "GET",
    path: "/api/v1/apps/{id}/charges",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "apps.charges.create",
    description: "Create an arbitrary app charge request.",
    method: "POST",
    path: "/api/v1/apps/{id}/charges",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "apps.charges.checkout",
    description: "Create a checkout session for an app charge request.",
    method: "POST",
    path: "/api/v1/apps/{id}/charges/{chargeId}/checkout",
    pathParams: ["id", "chargeId"],
    risk: "paid",
  },
  {
    command: "x402.requests.list",
    description: "List durable x402 payment requests.",
    method: "GET",
    path: "/api/v1/x402/requests",
    risk: "read",
  },
  {
    command: "x402.requests.get",
    description: "Fetch one durable x402 payment request.",
    method: "GET",
    path: "/api/v1/x402/requests/{id}",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "x402.requests.create",
    description: "Create a durable x402 payment request.",
    method: "POST",
    path: "/api/v1/x402/requests",
    risk: "paid",
  },
  {
    command: "x402.requests.settle",
    description:
      "Settle a durable x402 payment request with an X-PAYMENT payload.",
    method: "POST",
    path: "/api/v1/x402/requests/{id}/settle",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "domains.search",
    description: "Search domain availability and price estimates.",
    method: "POST",
    path: "/api/v1/domains/search",
    risk: "dry-run",
  },
  {
    command: "domains.list",
    description: "List domains owned or managed by the authenticated account.",
    method: "GET",
    path: "/api/v1/domains",
    risk: "read",
  },
  {
    command: "domains.check",
    description:
      "Check whether a domain can be attached or purchased for an app.",
    method: "POST",
    path: "/api/v1/apps/{id}/domains/check",
    pathParams: ["id"],
    risk: "dry-run",
  },
  {
    command: "domains.attach",
    description:
      "Attach an existing external domain to an app and return verification details.",
    method: "POST",
    path: "/api/v1/apps/{id}/domains",
    pathParams: ["id"],
    risk: "mutating",
  },
  {
    command: "domains.buy",
    description: "Buy/register a domain for an app.",
    method: "POST",
    path: "/api/v1/apps/{id}/domains/buy",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "domains.app.list",
    description: "List domains attached to an app.",
    method: "GET",
    path: "/api/v1/apps/{id}/domains",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "domains.status",
    description: "Check managed domain DNS/verification status for an app.",
    method: "POST",
    path: "/api/v1/apps/{id}/domains/status",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "domains.verify",
    description:
      "Verify an external domain attachment after DNS challenge setup.",
    method: "POST",
    path: "/api/v1/apps/{id}/domains/verify",
    pathParams: ["id"],
    risk: "mutating",
  },
  {
    command: "domains.sync",
    description: "Sync Cloudflare-backed domain metadata for an app.",
    method: "POST",
    path: "/api/v1/apps/{id}/domains/sync",
    pathParams: ["id"],
    risk: "mutating",
  },
  {
    command: "domains.detach",
    description:
      "Detach a domain from an app without deleting registrar ownership.",
    method: "DELETE",
    path: "/api/v1/apps/{id}/domains",
    pathParams: ["id"],
    risk: "destructive",
  },
  {
    command: "domains.dns.list",
    description: "List DNS records for a Cloudflare-managed app domain.",
    method: "GET",
    path: "/api/v1/apps/{id}/domains/{domain}/dns",
    pathParams: ["id", "domain"],
    risk: "read",
  },
  {
    command: "domains.dns.create",
    description: "Create a DNS record for a Cloudflare-managed app domain.",
    method: "POST",
    path: "/api/v1/apps/{id}/domains/{domain}/dns",
    pathParams: ["id", "domain"],
    risk: "mutating",
  },
  {
    command: "domains.dns.update",
    description: "Update a DNS record for a Cloudflare-managed app domain.",
    method: "PATCH",
    path: "/api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
    pathParams: ["id", "domain", "recordId"],
    risk: "mutating",
  },
  {
    command: "domains.dns.delete",
    description: "Delete a DNS record for a Cloudflare-managed app domain.",
    method: "DELETE",
    path: "/api/v1/apps/{id}/domains/{domain}/dns/{recordId}",
    pathParams: ["id", "domain", "recordId"],
    risk: "destructive",
  },
  {
    command: "containers.list",
    description: "List Cloud containers for the authenticated organization.",
    method: "GET",
    path: "/api/v1/containers",
    risk: "read",
  },
  {
    command: "containers.get",
    description: "Fetch one Cloud container by id.",
    method: "GET",
    path: "/api/v1/containers/{id}",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "containers.quota",
    description:
      "Read container quota, pricing, daily burn, and credit runway.",
    method: "GET",
    path: "/api/v1/containers/quota",
    risk: "read",
  },
  {
    command: "containers.create",
    description: "Create and deploy a Cloud container.",
    method: "POST",
    path: "/api/v1/containers",
    risk: "paid",
  },
  {
    command: "containers.update",
    description: "Update, restart, scale, or change env for a Cloud container.",
    method: "PATCH",
    path: "/api/v1/containers/{id}",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "containers.delete",
    description: "Delete a Cloud container.",
    method: "DELETE",
    path: "/api/v1/containers/{id}",
    pathParams: ["id"],
    risk: "destructive",
  },
  {
    command: "promote.assets.inspect",
    description: "Inspect existing promotional assets for an app.",
    method: "GET",
    path: "/api/v1/apps/{id}/promote/assets",
    pathParams: ["id"],
    risk: "read",
  },
  {
    command: "promote.assets.generate",
    description: "Generate app promotional assets and copy.",
    method: "POST",
    path: "/api/v1/apps/{id}/promote/assets",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "promote.execute",
    description: "Run configured app promotion workflows.",
    method: "POST",
    path: "/api/v1/apps/{id}/promote",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "media.image.generate",
    description: "Generate image content through Eliza Cloud.",
    method: "POST",
    path: "/api/v1/generate-image",
    risk: "paid",
  },
  {
    command: "media.video.generate",
    description: "Generate video content through Eliza Cloud.",
    method: "POST",
    path: "/api/v1/generate-video",
    risk: "paid",
  },
  {
    command: "media.music.generate",
    description:
      "Generate music content through Eliza Cloud using Fal, ElevenLabs, or a configured Suno-compatible provider.",
    method: "POST",
    path: "/api/v1/generate-music",
    risk: "paid",
  },
  {
    command: "media.tts.generate",
    description: "Generate TTS audio through Eliza Cloud.",
    method: "POST",
    path: "/api/v1/voice/tts",
    risk: "paid",
  },
  {
    command: "advertising.accounts.list",
    description: "List connected advertising accounts.",
    method: "GET",
    path: "/api/v1/advertising/accounts",
    risk: "read",
  },
  {
    command: "advertising.accounts.connect",
    description: "Connect an advertising account using provider credentials.",
    method: "POST",
    path: "/api/v1/advertising/accounts",
    risk: "mutating",
  },
  {
    command: "advertising.accounts.discover",
    description: "List selectable provider ad accounts from a temporary provider access token.",
    method: "POST",
    path: "/api/v1/advertising/accounts/discover",
    risk: "read",
  },
  {
    command: "advertising.campaigns.list",
    description: "List advertising campaigns.",
    method: "GET",
    path: "/api/v1/advertising/campaigns",
    risk: "read",
  },
  {
    command: "advertising.campaigns.create",
    description: "Create a paid advertising campaign.",
    method: "POST",
    path: "/api/v1/advertising/campaigns",
    risk: "paid",
  },
  {
    command: "advertising.campaigns.start",
    description: "Start a paid advertising campaign.",
    method: "POST",
    path: "/api/v1/advertising/campaigns/{id}/start",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "advertising.campaigns.pause",
    description: "Pause a paid advertising campaign.",
    method: "POST",
    path: "/api/v1/advertising/campaigns/{id}/pause",
    pathParams: ["id"],
    risk: "mutating",
  },
  {
    command: "advertising.creatives.create",
    description: "Create advertising creative assets for a campaign.",
    method: "POST",
    path: "/api/v1/advertising/campaigns/{id}/creatives",
    pathParams: ["id"],
    risk: "paid",
  },
  {
    command: "redemptions.balance",
    description: "Read creator redeemable-earnings balance.",
    method: "GET",
    path: "/api/v1/redemptions/balance",
    risk: "read",
  },
  {
    command: "redemptions.quote",
    description: "Quote a creator payout/redemption.",
    method: "GET",
    path: "/api/v1/redemptions/quote",
    risk: "read",
  },
  {
    command: "redemptions.create",
    description: "Create a payout/redemption request.",
    method: "POST",
    path: "/api/v1/redemptions",
    risk: "paid",
  },
  {
    command: "billing.active",
    description: "Read active billing resources.",
    method: "GET",
    path: "/api/v1/billing/active",
    risk: "read",
  },
  {
    command: "billing.ledger",
    description: "Read billing ledger entries.",
    method: "GET",
    path: "/api/v1/billing/ledger",
    risk: "read",
  },
  {
    command: "billing.settings.get",
    description: "Read Cloud billing settings.",
    method: "GET",
    path: "/api/v1/billing/settings",
    risk: "read",
  },
  {
    command: "billing.settings.update",
    description:
      "Update Cloud billing settings such as pay-as-you-go from earnings.",
    method: "PUT",
    path: "/api/v1/billing/settings",
    risk: "mutating",
  },
  {
    command: "dashboard.get",
    description: "Read Cloud dashboard overview.",
    method: "GET",
    path: "/api/v1/dashboard",
    risk: "read",
  },
];

const CLOUD_COMMANDS_BY_NAME = new Map(
  CLOUD_COMMANDS.map((definition) => [definition.command, definition]),
);

export interface ParentAgentBrokerRequest {
  runtime: IAgentRuntime;
  sessionId: string;
  session?: SessionInfo;
  args: unknown;
}

function getLogger(runtime: IAgentRuntime): Logger | undefined {
  return (runtime as IAgentRuntime & { logger?: Logger }).logger;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return ACTION_LIST_LIMIT_DEFAULT;
  }
  return Math.max(1, Math.min(ACTION_LIST_LIMIT_MAX, Math.floor(value)));
}

function normalizeMode(value: unknown): ParentAgentMode {
  const normalized = normalizeString(value)?.toLowerCase().replace(/_/g, "-");
  if (normalized === "list-actions" || normalized === "actions") {
    return "list-actions";
  }
  if (
    normalized === "list-cloud-commands" ||
    normalized === "cloud-commands" ||
    normalized === "commands"
  ) {
    return "list-cloud-commands";
  }
  if (normalized === "cloud-command" || normalized === "cloud") {
    return "cloud-command";
  }
  return "ask";
}

function normalizeArgs(raw: unknown): ParentAgentBrokerArgs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      mode: "ask",
      limit: ACTION_LIST_LIMIT_DEFAULT,
      confirmed: false,
    };
  }
  const record = raw as Record<string, unknown>;
  const request =
    normalizeString(record.request) ??
    normalizeString(record.prompt) ??
    normalizeString(record.question) ??
    normalizeString(record.intent);
  const params = isRecord(record.params)
    ? record.params
    : isRecord(record.body)
      ? { body: record.body }
      : undefined;
  return {
    mode: normalizeMode(record.mode),
    request,
    query: normalizeString(record.query),
    limit: normalizeLimit(record.limit),
    command:
      normalizeString(record.command) ??
      normalizeString(record.action) ??
      normalizeString(record.cloudCommand),
    params,
    confirmed: record.confirmed === true || record.confirm === true,
  };
}

function truncate(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function actionDescription(action: {
  description?: string;
  descriptionCompressed?: string;
  compressedDescription?: string;
}): string {
  return (
    action.descriptionCompressed ??
    action.compressedDescription ??
    action.description ??
    ""
  );
}

function listActions(
  runtime: IAgentRuntime,
  query: string | undefined,
  limit: number,
): string {
  const actions = (runtime as RuntimeWithActions).actions ?? [];
  const normalizedQuery = query?.toLowerCase();
  const filtered = actions
    .filter((action) => typeof action.name === "string" && action.name)
    .filter((action) => {
      if (!normalizedQuery) return true;
      const haystack = [
        action.name,
        actionDescription(action),
        ...(action.similes ?? []),
        ...(action.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .slice(0, limit);

  if (filtered.length === 0) {
    return query
      ? `No parent actions matched query "${query}".`
      : "No parent actions are currently registered.";
  }

  const lines = filtered.map((action) => {
    const mode = action.mode ? ` mode=${action.mode}` : "";
    const desc = truncate(actionDescription(action), 180);
    return `- ${action.name}${mode}${desc ? `: ${desc}` : ""}`;
  });
  return [
    `Parent Eliza actions${query ? ` matching "${query}"` : ""}:`,
    ...lines,
  ].join("\n");
}

function listCloudCommands(query: string | undefined, limit: number): string {
  const normalizedQuery = query?.toLowerCase();
  const filtered = CLOUD_COMMANDS.filter((definition) => {
    if (!normalizedQuery) return true;
    return `${definition.command} ${definition.description} ${definition.method} ${definition.path} ${definition.risk}`
      .toLowerCase()
      .includes(normalizedQuery);
  }).slice(0, limit);

  if (filtered.length === 0) {
    return query
      ? `No Eliza Cloud commands matched query "${query}".`
      : "No Eliza Cloud commands are currently registered.";
  }

  return [
    `Eliza Cloud commands${query ? ` matching "${query}"` : ""}:`,
    ...filtered.map(
      (definition) =>
        `- ${definition.command} [${definition.risk}] ${definition.method} ${definition.path}: ${definition.description}`,
    ),
    "",
    'Use `mode:"cloud-command"` with `command` and optional `params`. Mutating, paid, and destructive commands require `confirmed:true` after parent/user approval.',
  ].join("\n");
}

function runtimeSetting(
  runtime: IAgentRuntime,
  key: string,
): string | undefined {
  const runtimeWithSettings = runtime as IAgentRuntime & {
    getSetting?: (setting: string) => unknown;
  };
  return normalizeString(runtimeWithSettings.getSetting?.(key));
}

function resolveCloudBaseUrl(runtime: IAgentRuntime): string {
  const raw =
    readConfigEnvKey("ELIZA_CLOUD_BASE_URL") ??
    readConfigEnvKey("ELIZA_CLOUD_URL") ??
    readConfigEnvKey("ELIZAOS_CLOUD_URL") ??
    runtimeSetting(runtime, "ELIZA_CLOUD_BASE_URL") ??
    runtimeSetting(runtime, "ELIZA_CLOUD_URL") ??
    runtimeSetting(runtime, "ELIZAOS_CLOUD_URL") ??
    normalizeString(process.env.ELIZA_CLOUD_BASE_URL) ??
    normalizeString(process.env.ELIZA_CLOUD_URL) ??
    normalizeString(process.env.ELIZAOS_CLOUD_URL) ??
    DEFAULT_CLOUD_BASE_URL;

  return raw
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/, "")
    .replace(/\/api$/, "");
}

function resolveCloudApiKey(runtime: IAgentRuntime): string | undefined {
  return (
    readConfigCloudKey("apiKey") ??
    readConfigCloudKey("api_key") ??
    runtimeSetting(runtime, "ELIZAOS_CLOUD_API_KEY") ??
    runtimeSetting(runtime, "ELIZA_CLOUD_API_KEY") ??
    normalizeString(process.env.ELIZAOS_CLOUD_API_KEY) ??
    normalizeString(process.env.ELIZA_CLOUD_API_KEY)
  );
}

function pathParam(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const direct = normalizeString(params[name]);
  if (direct) return direct;
  if (name === "id") {
    return (
      normalizeString(params.appId) ??
      normalizeString(params.applicationId) ??
      normalizeString(params.domainId) ??
      normalizeString(params.campaignId) ??
      normalizeString(params.paymentRequestId)
    );
  }
  if (name === "chargeId") {
    return normalizeString(params.charge_id);
  }
  return undefined;
}

function buildCloudUrl(
  runtime: IAgentRuntime,
  definition: CloudCommandDefinition,
  params: Record<string, unknown>,
): { url?: URL; error?: string } {
  let path = definition.path;
  for (const name of definition.pathParams ?? []) {
    const value = pathParam(params, name);
    if (!value) {
      return {
        error: `Cloud command ${definition.command} requires params.${name}.`,
      };
    }
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }

  const url = new URL(path, resolveCloudBaseUrl(runtime));
  const query = isRecord(params.query) ? params.query : undefined;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) {
            url.searchParams.append(key, String(item));
          }
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return { url };
}

function cloudBody(
  definition: CloudCommandDefinition,
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (definition.method === "GET" || definition.method === "DELETE") {
    return undefined;
  }
  if (isRecord(params.body)) return params.body;
  if (isRecord(params.json)) return params.json;

  const reserved = new Set(["query", "confirmed", "confirm", "params"]);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (reserved.has(key)) continue;
    body[key] = value;
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

function redactedCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactedCopy(entry));
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      /api[-_]?key|token|secret|private|password|authorization|signature/i.test(
        key,
      )
    ) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redactedCopy(entry);
    }
  }
  return redacted;
}

async function responsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return redactedCopy(await response.json());
  }
  if (
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("image/") ||
    contentType.includes("octet-stream")
  ) {
    const bytes = await response.arrayBuffer();
    return {
      binary: true,
      contentType,
      bytes: bytes.byteLength,
    };
  }
  const text = await response.text();
  return text;
}

async function runCloudCommand(args: {
  runtime: IAgentRuntime;
  command: string | undefined;
  params?: Record<string, unknown>;
  confirmed: boolean;
}): Promise<{
  success: boolean;
  text: string;
  data?: Record<string, unknown>;
}> {
  if (!args.command) {
    return {
      success: false,
      text: 'Cloud command mode requires a `command` string. Use `mode:"list-cloud-commands"` to inspect available commands.',
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: "cloud-command",
      },
    };
  }

  const commandName = args.command.trim();
  const definition = CLOUD_COMMANDS_BY_NAME.get(commandName);
  if (!definition) {
    return {
      success: false,
      text: `Unknown Eliza Cloud command "${commandName}". Use \`mode:"list-cloud-commands"\` to inspect available commands.`,
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: "cloud-command",
        command: commandName,
      },
    };
  }

  const needsConfirmation =
    definition.risk === "mutating" ||
    definition.risk === "paid" ||
    definition.risk === "destructive";
  if (needsConfirmation && !args.confirmed) {
    return {
      success: false,
      text: [
        `confirmation_required: ${definition.command} is a ${definition.risk} Cloud command.`,
        "Ask the parent/user to approve the exact operation, budget/spend if any, and target account. Re-run with `confirmed:true` only after approval.",
      ].join("\n"),
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: "cloud-command",
        command: definition.command,
        risk: definition.risk,
        confirmationRequired: true,
      },
    };
  }

  const apiKey = resolveCloudApiKey(args.runtime);
  if (!apiKey) {
    return {
      success: false,
      text: "Eliza Cloud API key is not configured for the parent-agent broker. Configure `ELIZAOS_CLOUD_API_KEY`, `ELIZA_CLOUD_API_KEY`, or the paired Cloud API key before running Cloud commands.",
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: "cloud-command",
        command: definition.command,
      },
    };
  }

  const params = args.params ?? {};
  const built = buildCloudUrl(args.runtime, definition, params);
  if (!built.url) {
    return {
      success: false,
      text: built.error ?? `Failed to build URL for ${definition.command}.`,
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: "cloud-command",
        command: definition.command,
      },
    };
  }

  const body = cloudBody(definition, params);
  const response = await fetch(built.url, {
    method: definition.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-API-Key": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await responsePayload(response);
  const payloadText =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const text = [
    `Eliza Cloud command ${definition.command} ${response.ok ? "succeeded" : "failed"} (${response.status}).`,
    "",
    truncate(payloadText, CLOUD_RESPONSE_MAX_CHARS),
  ].join("\n");

  return {
    success: response.ok,
    text,
    data: {
      actionName: PARENT_AGENT_BROKER_SLUG,
      mode: "cloud-command",
      command: definition.command,
      risk: definition.risk,
      status: response.status,
      path: `${built.url.pathname}${built.url.search}`,
    },
  };
}

function buildBrokerMemory(args: {
  runtime: IAgentRuntime;
  sessionId: string;
  session?: SessionInfo;
  request: string;
}): Memory {
  const metadata = args.session?.metadata;
  const runtimeAgentId = (args.runtime as IAgentRuntime & { agentId?: string })
    .agentId;
  const entityId =
    normalizeString(metadata?.userId) ??
    normalizeString(metadata?.entityId) ??
    `child-session:${args.sessionId}`;
  const roomId =
    normalizeString(metadata?.roomId) ??
    normalizeString(metadata?.threadId) ??
    normalizeString(runtimeAgentId) ??
    `child-session:${args.sessionId}`;
  const worldId = normalizeString(metadata?.worldId);
  const source = normalizeString(metadata?.source) ?? "parent-agent-broker";

  return {
    content: {
      text: [
        "Task-agent request to parent Eliza:",
        "",
        args.request,
        "",
        "Respond with the result, or ask the user for confirmation if the requested capability requires approval.",
      ].join("\n"),
      source,
    },
    entityId,
    roomId,
    ...(worldId ? { worldId } : {}),
    metadata: {
      parentAgentBroker: true,
      childSessionId: args.sessionId,
    },
    createdAt: Date.now(),
  } as Memory;
}

async function askParentAgent(request: {
  runtime: IAgentRuntime;
  sessionId: string;
  session?: SessionInfo;
  text: string;
}): Promise<string> {
  const messageService = request.runtime.messageService;
  if (!messageService?.handleMessage) {
    return "Parent message service is not available in this runtime.";
  }

  const captured: string[] = [];
  const callback: HandlerCallback = async (content) => {
    if (typeof content?.text === "string" && content.text.trim()) {
      captured.push(content.text.trim());
    }
    return [];
  };

  const memory = buildBrokerMemory({
    runtime: request.runtime,
    sessionId: request.sessionId,
    session: request.session,
    request: request.text,
  });

  await request.runtime.createMemory(memory, "messages").catch((error) => {
    getLogger(request.runtime)?.warn?.(
      {
        src: LOG_PREFIX,
        event: "create_memory_failed",
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : String(error),
      },
      `${LOG_PREFIX} failed to create request memory`,
    );
  });

  const result = await messageService.handleMessage(
    request.runtime,
    memory,
    callback,
    {
      continueAfterActions: true,
    },
  );

  const resultText =
    typeof result.responseContent?.text === "string"
      ? result.responseContent.text.trim()
      : "";
  const capturedText = captured.join("\n").trim();
  if (resultText) return resultText;
  if (capturedText) return capturedText;
  if (result.reason) return `Parent agent did not respond: ${result.reason}`;
  return "Parent agent completed the request without visible output.";
}

export async function runParentAgentBroker(
  request: ParentAgentBrokerRequest,
): Promise<{ success: boolean; text: string; data?: Record<string, unknown> }> {
  const log = getLogger(request.runtime);
  const args = normalizeArgs(request.args);

  log?.info?.(
    {
      src: LOG_PREFIX,
      event: "request",
      sessionId: request.sessionId,
      mode: args.mode,
      hasRequest: Boolean(args.request),
      query: args.query ?? null,
      command: args.command ?? null,
    },
    `${LOG_PREFIX} broker request`,
  );

  if (args.mode === "list-actions") {
    return {
      success: true,
      text: listActions(request.runtime, args.query, args.limit),
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: args.mode,
      },
    };
  }

  if (args.mode === "list-cloud-commands") {
    return {
      success: true,
      text: listCloudCommands(args.query, args.limit),
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: args.mode,
      },
    };
  }

  if (args.mode === "cloud-command") {
    try {
      return await runCloudCommand({
        runtime: request.runtime,
        command: args.command,
        params: args.params,
        confirmed: args.confirmed,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown error: ${String(error)}`;
      log?.error?.(
        {
          src: LOG_PREFIX,
          event: "cloud_command_error",
          sessionId: request.sessionId,
          command: args.command ?? null,
          error: message,
        },
        `${LOG_PREFIX} cloud command failed`,
      );
      return {
        success: false,
        text: `Eliza Cloud command failed: ${message}`,
        data: {
          actionName: PARENT_AGENT_BROKER_SLUG,
          mode: args.mode,
          command: args.command,
        },
      };
    }
  }

  if (!args.request) {
    return {
      success: false,
      text: 'Parent agent broker requires a `request` string, for example `USE_SKILL parent-agent {"request":"Search my calendar for tomorrow afternoon"}`.',
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: args.mode,
      },
    };
  }

  const requestText = truncate(args.request, REQUEST_MAX_CHARS);
  try {
    const text = await askParentAgent({
      runtime: request.runtime,
      sessionId: request.sessionId,
      session: request.session,
      text: requestText,
    });
    return {
      success: true,
      text: `Parent Eliza agent response:\n\n${text}`,
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: args.mode,
      },
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Unknown error: ${String(error)}`;
    log?.error?.(
      {
        src: LOG_PREFIX,
        event: "error",
        sessionId: request.sessionId,
        error: message,
      },
      `${LOG_PREFIX} broker failed`,
    );
    return {
      success: false,
      text: `Parent agent broker failed: ${message}`,
      data: {
        actionName: PARENT_AGENT_BROKER_SLUG,
        mode: args.mode,
      },
    };
  }
}
