/**
 * ElizaCloud v1 API helpers used by the ElizaOK dashboard server.
 *
 * ## Why this file exists
 * The dashboard must call ElizaCloud with `fetch()` from **Node** (no browser cookies to Cloud).
 * Auth rules and response shapes are easy to get wrong if copy-pasted across `server.ts`.
 * Keeping them here makes behavior **testable** and **documented in one place**.
 *
 * ## Why header rules are non-obvious
 * ElizaCloud’s `requireAuthOrApiKey` checks **X-API-Key before Authorization**.
 * - **Opaque API keys:** send both `Authorization: Bearer <key>` and `X-API-Key: <key>` so we match
 *   Cloud’s SDK pattern and the primary validation path.
 * - **Privy JWT (three dot-separated segments):** send **Bearer only**. If we put a JWT in
 *   `X-API-Key`, Cloud would try to validate it as an API key first and **fail**.
 *
 * ## Why parsers are defensive
 * Minor proxy or versioning drift should not blank credits in the UI. We accept a few alternate
 * shapes (e.g. nested `data.balance`, `credit_balance` vs `creditBalance`) but reject `NaN`.
 *
 * ## Why 429 retry only on credits routes
 * `/api/v1/credits/summary` is rate-limited on Cloud. Parallel refresh (models + user + balance +
 * summary) can hit 429; **one** capped retry reduces flaky “credits syncing” without slowing every
 * request type.
 *
 * @see apps/elizaokbsc/docs/elizacloud-integration.md for full rationale and env split (two base URLs).
 */

export interface ElizaCloudUserProfile {
  displayName: string;
  email: string;
  credits: string | null;
  plan: string;
  avatarUrl: string | null;
  walletAddress: string;
  organizationName: string;
  organizationSlug: string;
}

export interface ElizaCloudSummaryFields {
  displayName?: string;
  organizationName?: string;
  credits?: string;
  agents?: ElizaCloudCreditAgent[];
  agentsSummary?: ElizaCloudAgentsSummary;
  pricing?: ElizaCloudPricingSummary;
  autoTopUp?: ElizaCloudAutoTopUpSummary;
}

export interface ElizaCloudAgentConfig {
  id: string;
  name: string;
  model: string;
  modelProvider: string;
}

export interface ElizaCloudCreditAgent {
  id: string;
  name: string;
  allocated: number;
  spent: number;
  available: number;
  hasBudget: boolean;
  isPaused: boolean;
  totalRequests: number;
  dailyLimit: number | null;
}

export interface ElizaCloudAgentsSummary {
  total: number;
  withBudget: number;
  paused: number;
  totalAllocated: number;
  totalSpent: number;
  totalAvailable: number;
}

export interface ElizaCloudPricingSummary {
  creditsPerDollar: number | null;
  minimumTopUp: number | null;
  x402Enabled: boolean;
}

export interface ElizaCloudAutoTopUpSummary {
  enabled: boolean;
  threshold: number | null;
  amount: number | null;
  hasPaymentMethod: boolean;
}

function isElizaCloudDebugEnabled(): boolean {
  return process.env.ELIZAOK_ELIZA_CLOUD_DEBUG?.trim() === "true";
}

function shortCredential(credential: string): string {
  if (!credential) return "empty";
  if (credential.length <= 12) return credential;
  return `${credential.slice(0, 8)}...${credential.slice(-4)}`;
}

function debugElizaCloud(event: string, payload: Record<string, unknown>): void {
  if (!isElizaCloudDebugEnabled()) return;
  try {
    console.warn(`[ElizaCloudDebug] ${event}`, JSON.stringify(payload, null, 2));
  } catch {
    console.warn(`[ElizaCloudDebug] ${event}`, payload);
  }
}

async function debugResponseBody(response: Response): Promise<string | null> {
  if (!isElizaCloudDebugEnabled()) return null;
  try {
    const text = await response.clone().text();
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  } catch {
    return null;
  }
}

/** Mirrors ElizaCloud’s JWT heuristic: three non-empty segments. Used to avoid sending JWTs as X-API-Key. */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Builds headers for ElizaCloud v1 `fetch` calls.
 * Why `x-api-key` is conditional: see file-level doc (JWT must not be sent as API key).
 */
export function elizaCloudAuthHeaders(
  credential: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${credential}`,
  };
  if (!looksLikeJwt(credential)) {
    headers["x-api-key"] = credential;
  }
  return headers;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One retry: Cloud summary (and sometimes bursts) can 429; avoids persistent “credits syncing”. */
async function fetchWithOne429Retry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status !== 429) {
    return response;
  }
  const retryAfter = response.headers.get("Retry-After");
  let delayMs = 500;
  if (retryAfter) {
    const sec = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(sec)) {
      delayMs = Math.min(sec * 1000, 3000);
    }
  }
  await sleepMs(delayMs);
  return fetch(url, init);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Canonical `{ balance }`; also accepts nested `data.balance`. Returns null for NaN so UI does not show garbage. */
export function parseCreditsBalancePayload(json: unknown): string | null {
  const root = asRecord(json);
  if (!root) return null;
  const raw =
    root["balance"] !== undefined && root["balance"] !== null
      ? root["balance"]
      : (() => {
          const data = asRecord(root["data"]);
          return data &&
            data["balance"] !== undefined &&
            data["balance"] !== null
            ? data["balance"]
            : undefined;
        })();
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (Number.isNaN(n)) return null;
  return String(n);
}

/**
 * Cloud returns `organization.creditBalance` (camelCase). We fall back to `credit_balance` so a
 * snake_case serializer or older payload still works.
 */
export function parseCreditsSummaryPayload(
  json: unknown,
): ElizaCloudSummaryFields | null {
  const root = asRecord(json);
  if (!root) return null;
  const org = asRecord(root["organization"]);
  if (!org) return null;

  const organizationName =
    typeof org["name"] === "string" ? org["name"].trim() : "";

  const camel = org["creditBalance"];
  const snake = org["credit_balance"];
  const balanceRaw =
    camel !== undefined && camel !== null
      ? camel
      : snake !== undefined && snake !== null
        ? snake
        : undefined;

  let credits: string | undefined;
  if (balanceRaw !== undefined && balanceRaw !== null) {
    const n = Number(balanceRaw);
    credits = Number.isNaN(n) ? undefined : String(n);
  }

  const agents = Array.isArray(root["agents"])
    ? root["agents"]
        .map((entry) => {
          const agent = asRecord(entry);
          if (!agent) return null;
          const id =
            typeof agent["id"] === "string" ? agent["id"].trim() : "";
          const name =
            typeof agent["name"] === "string" ? agent["name"].trim() : "";
          if (!id || !name) return null;
          return {
            id,
            name,
            allocated: asNumber(agent["allocated"]) ?? 0,
            spent: asNumber(agent["spent"]) ?? 0,
            available: asNumber(agent["available"]) ?? 0,
            hasBudget: Boolean(agent["hasBudget"]),
            isPaused: Boolean(agent["isPaused"]),
            totalRequests: asNumber(agent["totalRequests"]) ?? 0,
            dailyLimit: asNumber(agent["dailyLimit"]),
          } satisfies ElizaCloudCreditAgent;
        })
        .filter((entry): entry is ElizaCloudCreditAgent => Boolean(entry))
    : [];

  const agentsSummaryRaw = asRecord(root["agentsSummary"]);
  const agentsSummary = agentsSummaryRaw
    ? {
        total: asNumber(agentsSummaryRaw["total"]) ?? agents.length,
        withBudget: asNumber(agentsSummaryRaw["withBudget"]) ?? 0,
        paused: asNumber(agentsSummaryRaw["paused"]) ?? 0,
        totalAllocated: asNumber(agentsSummaryRaw["totalAllocated"]) ?? 0,
        totalSpent: asNumber(agentsSummaryRaw["totalSpent"]) ?? 0,
        totalAvailable: asNumber(agentsSummaryRaw["totalAvailable"]) ?? 0,
      }
    : undefined;

  const pricingRaw = asRecord(root["pricing"]);
  const pricing = pricingRaw
    ? {
        creditsPerDollar: asNumber(pricingRaw["creditsPerDollar"]),
        minimumTopUp: asNumber(pricingRaw["minimumTopUp"]),
        x402Enabled: Boolean(pricingRaw["x402Enabled"]),
      }
    : undefined;

  const autoTopUp = {
    enabled: Boolean(org["autoTopUpEnabled"]),
    threshold: asNumber(org["autoTopUpThreshold"]),
    amount: asNumber(org["autoTopUpAmount"]),
    hasPaymentMethod: Boolean(org["hasPaymentMethod"]),
  } satisfies ElizaCloudAutoTopUpSummary;

  return {
    displayName: organizationName || undefined,
    organizationName: organizationName || undefined,
    credits,
    agents,
    agentsSummary,
    pricing,
    autoTopUp,
  };
}

function normalizeApiBase(apiBase: string): string {
  let base = apiBase.replace(/\/$/, "");
  base = base.replace(
    /^(https?:\/\/)elizacloud\.ai/i,
    "$1www.elizacloud.ai",
  );
  return base;
}

/** No 429 retry here: summary is the rate-limited route; keeps model fetch latency predictable. */
export async function fetchElizaCloudModels(
  apiBase: string,
  credential: string,
): Promise<string[]> {
  const url = `${normalizeApiBase(apiBase)}/api/v1/models`;
  const response = await fetch(url, {
    headers: elizaCloudAuthHeaders(credential),
  });
  const debugBody = await debugResponseBody(response);
  debugElizaCloud("models.response", {
    url,
    status: response.status,
    credential: shortCredential(credential),
    body: debugBody,
  });
  if (!response.ok) {
    return [];
  }
  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ id?: string }>;
  } | null;
  const models = (payload?.data || [])
    .map((entry) => entry.id?.trim())
    .filter((id): id is string => Boolean(id))
    .slice(0, 24);
  debugElizaCloud("models.parsed", { models });
  return models;
}

export async function fetchElizaCloudUser(
  apiBase: string,
  credential: string,
): Promise<ElizaCloudUserProfile | null> {
  const url = `${normalizeApiBase(apiBase)}/api/v1/user`;
  const response = await fetch(url, {
    headers: elizaCloudAuthHeaders(credential),
  });
  const debugBody = await debugResponseBody(response);
  debugElizaCloud("user.response", {
    url,
    status: response.status,
    credential: shortCredential(credential),
    body: debugBody,
  });
  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as
    | {
        data?: Record<string, unknown>;
        user?: Record<string, unknown>;
        organization?: Record<string, unknown>;
      }
    | Record<string, unknown>
    | null;
  const payloadRecord =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const data =
    payloadRecord?.["data"] && typeof payloadRecord["data"] === "object"
      ? (payloadRecord["data"] as Record<string, unknown>)
      : payloadRecord?.["user"] && typeof payloadRecord["user"] === "object"
        ? (payloadRecord["user"] as Record<string, unknown>)
        : payloadRecord
          ? payloadRecord
          : null;

  if (!data) {
    return null;
  }

  const organization =
    payloadRecord?.["organization"] &&
    typeof payloadRecord["organization"] === "object"
      ? (payloadRecord["organization"] as Record<string, unknown>)
      : data["organization"] && typeof data["organization"] === "object"
        ? (data["organization"] as Record<string, unknown>)
        : null;

  const email =
    (typeof data["email"] === "string" && data["email"]) ||
    (typeof data["user_email"] === "string" && data["user_email"]) ||
    "";
  const displayName =
    (typeof data["name"] === "string" && data["name"]) ||
    (typeof data["displayName"] === "string" && data["displayName"]) ||
    (typeof data["username"] === "string" && data["username"]) ||
    email ||
    "ElizaCloud User";
  const creditsRaw =
    (typeof data["credits"] === "string" && data["credits"]) ||
    (typeof data["credits"] === "number" && String(data["credits"])) ||
    (typeof data["credit_balance"] === "string" && data["credit_balance"]) ||
    (typeof data["credit_balance"] === "number" &&
      String(data["credit_balance"])) ||
    (organization &&
      typeof organization["credit_balance"] === "string" &&
      organization["credit_balance"]) ||
    (organization &&
      typeof organization["credit_balance"] === "number" &&
      String(organization["credit_balance"])) ||
    (typeof data["remainingCredits"] === "string" &&
      data["remainingCredits"]) ||
    (typeof data["remainingCredits"] === "number" &&
      String(data["remainingCredits"])) ||
    null;
  const plan =
    (typeof data["plan"] === "string" && data["plan"]) ||
    (typeof data["subscription_plan"] === "string" &&
      data["subscription_plan"]) ||
    "ElizaCloud";
  const avatarUrl =
    (typeof data["avatar_url"] === "string" && data["avatar_url"]) ||
    (typeof data["image"] === "string" && data["image"]) ||
    (typeof data["avatar"] === "string" && data["avatar"]) ||
    null;
  const walletAddress =
    (typeof data["wallet_address"] === "string" && data["wallet_address"]) ||
    (typeof data["walletAddress"] === "string" && data["walletAddress"]) ||
    "";
  const organizationName =
    (organization &&
      typeof organization["name"] === "string" &&
      organization["name"]) ||
    (typeof data["organization_name"] === "string" &&
      data["organization_name"]) ||
    "ElizaCloud";
  const organizationSlug =
    (organization &&
      typeof organization["slug"] === "string" &&
      organization["slug"]) ||
    (typeof data["organization_slug"] === "string" &&
      data["organization_slug"]) ||
    "elizacloud";

  const profile = {
    displayName,
    email,
    credits: creditsRaw,
    plan,
    avatarUrl,
    walletAddress,
    organizationName,
    organizationSlug,
  };
  debugElizaCloud("user.parsed", profile);
  return profile;
}

export async function fetchElizaCloudCreditsBalance(
  apiBase: string,
  credential: string,
): Promise<string | null> {
  const url = `${normalizeApiBase(apiBase)}/api/v1/credits/balance`;
  const init: RequestInit = {
    headers: elizaCloudAuthHeaders(credential),
  };
  const response = await fetchWithOne429Retry(url, init);
  const debugBody = await debugResponseBody(response);
  debugElizaCloud("credits.balance.response", {
    url,
    status: response.status,
    credential: shortCredential(credential),
    body: debugBody,
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  const parsed = parseCreditsBalancePayload(payload);
  debugElizaCloud("credits.balance.parsed", { parsed });
  return parsed;
}

export async function fetchElizaCloudCreditsSummary(
  apiBase: string,
  credential: string,
): Promise<ElizaCloudSummaryFields | null> {
  const url = `${normalizeApiBase(apiBase)}/api/v1/credits/summary`;
  const init: RequestInit = {
    headers: elizaCloudAuthHeaders(credential),
  };
  const response = await fetchWithOne429Retry(url, init);
  const debugBody = await debugResponseBody(response);
  debugElizaCloud("credits.summary.response", {
    url,
    status: response.status,
    credential: shortCredential(credential),
    body: debugBody,
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  const parsed = parseCreditsSummaryPayload(payload);
  debugElizaCloud("credits.summary.parsed", parsed || { parsed: null });
  return parsed;
}

function parseCharacterListPayload(
  json: unknown,
): Array<Record<string, unknown>> {
  const root = asRecord(json);
  if (!root) return [];
  const data = asRecord(root["data"]);
  const characters = data?.["characters"];
  if (!Array.isArray(characters)) return [];
  return characters.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object",
  );
}

function parseCharacterDetailPayload(json: unknown): Record<string, unknown> | null {
  const root = asRecord(json);
  if (!root) return null;
  const data = asRecord(root["data"]);
  const character =
    data?.["character"] && typeof data["character"] === "object"
      ? (data["character"] as Record<string, unknown>)
      : root["character"] && typeof root["character"] === "object"
        ? (root["character"] as Record<string, unknown>)
        : data;
  return character && typeof character === "object" ? character : null;
}

function parseCharacterModel(
  character: Record<string, unknown>,
): ElizaCloudAgentConfig | null {
  const id =
    (typeof character["id"] === "string" && character["id"].trim()) || "";
  const name =
    (typeof character["name"] === "string" && character["name"].trim()) ||
    "Eliza";
  const modelProvider =
    findNestedProvider(character) ||
    ((typeof character["modelProvider"] === "string" &&
      character["modelProvider"].trim()) ||
      "");
  const settings = asRecord(character["settings"]);
  const model =
    (settings && typeof settings["model"] === "string" && settings["model"]) ||
    (typeof character["model"] === "string" && character["model"]) ||
    findNestedModel(character) ||
    "";
  if (!id) {
    return null;
  }
  return {
    id,
    name,
    model: model.trim() || "gpt-4o",
    modelProvider: modelProvider || "openai",
  };
}

function isKnownProvider(value: string): boolean {
  return [
    "openai",
    "anthropic",
    "google",
    "alibaba",
    "mistral",
    "meta",
    "deepseek",
    "xai",
    "groq",
    "together",
    "openrouter",
  ].includes(value.toLowerCase());
}

function looksLikeModelName(value: string): boolean {
  return /gpt|claude|gemini|qwen|llama|mistral|deepseek|sonnet|opus|flash|turbo|nano|mini|preview/i.test(
    value,
  );
}

function findNestedProvider(
  value: unknown,
  depth = 0,
): string {
  if (!value || depth > 6) return "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedProvider(entry, depth + 1);
      if (found) return found;
    }
    return "";
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const [key, entry] of Object.entries(record)) {
    if (
      /provider/i.test(key) &&
      typeof entry === "string" &&
      isKnownProvider(entry.trim())
    ) {
      return entry.trim();
    }
  }
  for (const entry of Object.values(record)) {
    const found = findNestedProvider(entry, depth + 1);
    if (found) return found;
  }
  return "";
}

function findNestedModel(
  value: unknown,
  depth = 0,
): string {
  if (!value || depth > 6) return "";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNestedModel(entry, depth + 1);
      if (found) return found;
    }
    return "";
  }
  const record = asRecord(value);
  if (!record) return "";
  for (const [key, entry] of Object.entries(record)) {
    if (
      /model/i.test(key) &&
      typeof entry === "string" &&
      looksLikeModelName(entry.trim())
    ) {
      return entry.trim();
    }
  }
  for (const entry of Object.values(record)) {
    const found = findNestedModel(entry, depth + 1);
    if (found) return found;
  }
  return "";
}

function collectInterestingPaths(
  value: unknown,
  currentPath = "root",
  depth = 0,
  results: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (!value || depth > 6 || results.length >= 24) {
    return results;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (results.length < 24) {
        collectInterestingPaths(entry, `${currentPath}[${index}]`, depth + 1, results);
      }
    });
    return results;
  }
  const record = asRecord(value);
  if (!record) {
    return results;
  }
  for (const [key, entry] of Object.entries(record)) {
    const path = `${currentPath}.${key}`;
    if (
      typeof entry === "string" &&
      /(model|provider|settings|config|runtime|deploy|llm)/i.test(key)
    ) {
      results.push({ path, value: entry.slice(0, 200) });
      if (results.length >= 24) {
        return results;
      }
    }
    if (entry && typeof entry === "object") {
      collectInterestingPaths(entry, path, depth + 1, results);
      if (results.length >= 24) {
        return results;
      }
    }
  }
  return results;
}

export async function fetchElizaCloudPrimaryAgentConfig(
  apiBase: string,
  credential: string,
): Promise<ElizaCloudAgentConfig | null> {
  const base = normalizeApiBase(apiBase);
  const listUrl = `${base}/api/my-agents/characters?limit=30&sortBy=updated&order=desc`;
  const listResponse = await fetch(listUrl, {
    headers: elizaCloudAuthHeaders(credential),
  });
  const listBody = await debugResponseBody(listResponse);
  debugElizaCloud("agents.list.response", {
    url: listUrl,
    status: listResponse.status,
    credential: shortCredential(credential),
    body: listBody,
  });
  if (!listResponse.ok) {
    return null;
  }
  const listPayload = await listResponse.json().catch(() => null);
  const characters = parseCharacterListPayload(listPayload);
  const primary = characters[0];
  const agentId =
    primary && typeof primary["id"] === "string" ? primary["id"].trim() : "";
  if (!agentId) {
    debugElizaCloud("agents.list.parsed", { agentId: null });
    return null;
  }
  const detailUrl = `${base}/api/my-agents/characters/${agentId}`;
  const detailResponse = await fetch(detailUrl, {
    headers: elizaCloudAuthHeaders(credential),
  });
  const detailBody = await debugResponseBody(detailResponse);
  debugElizaCloud("agents.detail.response", {
    url: detailUrl,
    status: detailResponse.status,
    credential: shortCredential(credential),
    body: detailBody,
  });
  if (!detailResponse.ok) {
    return null;
  }
  const detailPayload = await detailResponse.json().catch(() => null);
  const character = parseCharacterDetailPayload(detailPayload);
  const parsed = character ? parseCharacterModel(character) : null;
  debugElizaCloud(
    "agents.detail.parsed",
    parsed ||
      (character
        ? {
            parsed: null,
            interestingPaths: collectInterestingPaths(character),
            topLevelKeys: Object.keys(character).slice(0, 40),
            settingsPreview: (() => {
              try {
                return JSON.stringify(character["settings"] ?? null).slice(0, 800);
              } catch {
                return null;
              }
            })(),
            characterDataPreview: (() => {
              try {
                return JSON.stringify(character["character_data"] ?? null).slice(0, 800);
              } catch {
                return null;
              }
            })(),
          }
        : { parsed: null, character: null }),
  );
  return parsed;
}
