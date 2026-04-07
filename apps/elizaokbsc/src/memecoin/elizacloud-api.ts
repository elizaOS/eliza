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
  credits: string;
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

  return {
    displayName: organizationName || undefined,
    organizationName: organizationName || undefined,
    credits,
  };
}

function normalizeApiBase(apiBase: string): string {
  return apiBase.replace(/\/$/, "");
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
  if (!response.ok) {
    return [];
  }
  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ id?: string }>;
  } | null;
  return (payload?.data || [])
    .map((entry) => entry.id?.trim())
    .filter((id): id is string => Boolean(id))
    .slice(0, 24);
}

export async function fetchElizaCloudUser(
  apiBase: string,
  credential: string,
): Promise<ElizaCloudUserProfile | null> {
  const url = `${normalizeApiBase(apiBase)}/api/v1/user`;
  const response = await fetch(url, {
    headers: elizaCloudAuthHeaders(credential),
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
    "linked";
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

  return {
    displayName,
    email,
    credits: creditsRaw,
    plan,
    avatarUrl,
    walletAddress,
    organizationName,
    organizationSlug,
  };
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
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  return parseCreditsBalancePayload(payload);
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
  if (!response.ok) {
    return null;
  }
  const payload = await response.json().catch(() => null);
  return parseCreditsSummaryPayload(payload);
}
