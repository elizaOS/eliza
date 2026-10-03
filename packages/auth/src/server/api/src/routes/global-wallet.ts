import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { requireLoginValue } from "../../../../required";
import {
  agents,
  agentWallets,
  getDb,
  globalWalletActionConfirmations,
  tenantAppClients,
  userWalletAppConsents,
} from "../../../db/src/index.ts";
import type {
  ApiResponse,
  SignTypedDataRequest,
} from "../../../shared/src/index.ts";
import type { Vault } from "../../../vault/src/index.ts";
import { writeAuditEvent } from "../services/audit";
import {
  continueWithTenantDatabase,
  safeJsonParse,
  sanitizeErrorMessage,
  setNoStoreHeaders,
  verifySessionToken,
} from "../services/context";
import { isRecentMfaTimestamp } from "../services/recent-mfa";
import { getConfiguredVault } from "../services/vault-factory";

type UserSessionPayload = {
  userId: string;
  address?: string;
  email?: string;
  tenantId?: string;
  mfaVerifiedAt?: number;
  mfaMethod?: string;
  [key: string]: unknown;
};

type GlobalWalletVariables = {
  userId: string;
  userSession: UserSessionPayload;
  authType?: "session-jwt";
  sessionMfaVerifiedAt?: number;
  sessionMfaMethod?: string;
  requestId?: string;
};

type AppClientRow = typeof tenantAppClients.$inferSelect;
type ConsentRow = typeof userWalletAppConsents.$inferSelect;

const APP_ID_RE = /^([a-zA-Z0-9_\-.:]{1,64})\/([a-z0-9][a-z0-9_-]{2,63})$/;
const DEFAULT_ALLOWED_SCOPES = ["eth_accounts", "personal_sign"];
const READONLY_RPC_METHODS = new Set(["eth_accounts", "eth_chainId"]);
const WRITE_RPC_METHODS = new Set([
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
]);
const TRANSACTION_SCAN_METHODS = new Set(["eth_sendTransaction"]);
const CONFIRMABLE_RPC_METHODS = new Set([
  ...WRITE_RPC_METHODS,
  ...TRANSACTION_SCAN_METHODS,
]);
const SIGNING_RPC_METHODS = new Set([
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v1",
  "eth_signTypedData_v3",
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "wallet_sendCalls",
  "wallet_signCalls",
]);
const MFA_MAX_AGE_MS = 10 * 60_000;
const ALLOW_UNSAFE_MESSAGE_SIGNING =
  process.env.STEWARD_ALLOW_UNSAFE_MESSAGE_SIGNING === "true";
const ALLOW_GLOBAL_WALLET_PERSONAL_SIGN =
  process.env.STEWARD_ALLOW_GLOBAL_WALLET_PERSONAL_SIGN === "true";
const ALLOW_GLOBAL_WALLET_TYPED_DATA_SIGNING =
  process.env.STEWARD_ALLOW_GLOBAL_WALLET_TYPED_DATA_SIGNING === "true";
const ALLOW_GLOBAL_WALLET_SEND_TRANSACTION =
  process.env.STEWARD_ALLOW_GLOBAL_WALLET_SEND_TRANSACTION === "true";
const ACTION_CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_TRANSACTION_DATA_BYTES = 16_384;

export const globalWalletRoutes = new Hono<{
  Variables: GlobalWalletVariables;
}>();

async function userSessionAuth(
  c: Context<{ Variables: GlobalWalletVariables }>,
  next: Next,
): Promise<Response | undefined> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json<ApiResponse>(
      { ok: false, error: "Authorization: Bearer <token> header is required" },
      401,
    );
  }

  const payload = (await verifySessionToken(
    authHeader.slice(7),
  )) as UserSessionPayload | null;
  if (!payload?.userId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid or expired session token" },
      401,
    );
  }

  c.set("userId", payload.userId);
  c.set("userSession", payload);
  c.set("authType", "session-jwt");
  if (typeof payload.mfaVerifiedAt === "number")
    c.set("sessionMfaVerifiedAt", payload.mfaVerifiedAt);
  if (typeof payload.mfaMethod === "string")
    c.set("sessionMfaMethod", payload.mfaMethod);
  if (!payload.tenantId) {
    return c.json<ApiResponse>(
      { ok: false, error: "Session token missing tenantId claim" },
      401,
    );
  }
  await continueWithTenantDatabase(
    payload.tenantId,
    "global-wallet-jwt",
    payload.userId,
    next,
    payload.userId,
  );
  return undefined;
}

globalWalletRoutes.use("*", userSessionAuth);

function getVault(): Vault {
  return getConfiguredVault();
}

function parseAppId(
  value: unknown,
): { tenantId: string; clientId: string } | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(APP_ID_RE);
  if (!match) return null;
  return { tenantId: match[1], clientId: match[2] };
}

function parseWalletIndex(value: unknown): number | string {
  if (value === undefined || value === null || value === "") return 0;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    return "walletIndex must be an integer between 0 and 255";
  }
  return parsed;
}

function userWalletAgentId(userId: string, walletIndex: number): string {
  return walletIndex === 0
    ? `user-wallet-${userId}`
    : `user-wallet-${userId}-${walletIndex}`;
}

function walletIndexFromAgentId(
  userId: string,
  agentId: string | null,
): number | null {
  if (!agentId) return null;
  if (agentId === `user-wallet-${userId}`) return 0;
  const prefix = `user-wallet-${userId}-`;
  if (!agentId.startsWith(prefix)) return null;
  const parsed = parseWalletIndex(agentId.slice(prefix.length));
  return typeof parsed === "number" ? parsed : null;
}

function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function originFromReferer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeRedirectUri(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function requestOrigin(c: Context, explicitOrigin?: unknown): string | null {
  const explicit = normalizeOrigin(explicitOrigin);
  const originHeader = normalizeOrigin(c.req.header("Origin"));
  const refererOrigin = originFromReferer(c.req.header("Referer"));
  // Browser traffic: the browser-asserted Origin/Referer header wins and a
  // mismatched body field fails closed — a malicious page cannot lie about its
  // origin, so consent really is origin-bound.
  if (originHeader)
    return explicit && explicit !== originHeader ? null : originHeader;
  if (refererOrigin)
    return explicit && explicit !== refererOrigin ? null : refererOrigin;
  // SEC-212: non-browser callers send no Origin/Referer, so the body `origin`
  // field is self-asserted. The remaining controls are the app client's
  // allowedOrigins allowlist + user session + recent MFA — "origin-bound
  // consent" is NOT attested for these flows. Consent audits record
  // originSource so self-asserted grants are distinguishable.
  return explicit;
}

/** True when the request's origin was observed from an Origin/Referer header
 * (browser traffic) rather than self-asserted in the request body (SEC-212). */
function isHeaderObservedOrigin(c: Context): boolean {
  return Boolean(
    normalizeOrigin(c.req.header("Origin")) ??
      originFromReferer(c.req.header("Referer")),
  );
}

function parseScopes(
  value: unknown,
  allowed?: readonly string[] | null,
): string[] | string {
  const raw =
    value === undefined || value === null || value === ""
      ? ["eth_accounts"]
      : Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(/[,\s]+/)
          : null;
  if (!raw || !raw.every((scope) => typeof scope === "string"))
    return "scope must be a string or array";
  const scopes = [...new Set(raw.map((scope) => scope.trim()).filter(Boolean))];
  if (scopes.length === 0) return "scope must include at least one scope";
  const allowedSet = new Set(allowed ?? DEFAULT_ALLOWED_SCOPES);
  const unsupported = scopes.find((scope) => !allowedSet.has(scope));
  if (unsupported) return `unsupported scope: ${unsupported}`;
  return scopes;
}

function looksLikeAuthMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("wants you to sign in with your ethereum account") ||
    normalized.includes("sign-in with ethereum") ||
    normalized.includes("siwe") ||
    normalized.includes("permit(") ||
    normalized.includes("permit2")
  );
}

function parsePersonalSignParams(
  value: unknown,
): { message: string; address?: string } | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    return "personal_sign params must be [message, address]";
  }
  const [message, address] = value;
  if (typeof message !== "string" || !message.trim())
    return "personal_sign message is required";
  if (message.length > 16_384) return "personal_sign message is too large";
  if (
    address !== undefined &&
    (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))
  ) {
    return "personal_sign address must be a valid EVM address";
  }
  if (looksLikeAuthMessage(message)) {
    return "Refusing to sign authentication or permit-style messages";
  }
  return { message, address };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function globalWalletActionHash(input: {
  method: string;
  params: unknown;
  walletAgentId: string;
  walletAddress: string;
  walletIndex: number;
}): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function typedDataContainsPermit(input: {
  primaryType: string;
  types: Record<string, Array<{ name: string; type: string }>>;
}): boolean {
  const names = [input.primaryType, ...Object.keys(input.types)].map((name) =>
    name.toLowerCase(),
  );
  return names.some(
    (name) =>
      name === "permit" ||
      name.includes("permit") ||
      name.includes("permit2") ||
      name.includes("permittransfer") ||
      name.includes("permitbatch"),
  );
}

function parseTypedDataV4Params(
  value: unknown,
):
  | (Omit<SignTypedDataRequest, "agentId" | "tenantId"> & { address?: string })
  | string {
  if (!Array.isArray(value) || value.length !== 2) {
    return "eth_signTypedData_v4 params must be [address, typedData]";
  }
  const [address, rawTypedData] = value;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return "eth_signTypedData_v4 address must be a valid EVM address";
  }
  const typedData =
    typeof rawTypedData === "string"
      ? (() => {
          if (rawTypedData.length > 65_536) return null;
          try {
            return JSON.parse(rawTypedData) as unknown;
          } catch {
            return null;
          }
        })()
      : rawTypedData;
  if (!isPlainObject(typedData))
    return "eth_signTypedData_v4 typedData must be an object";
  if (!isPlainObject(typedData.domain))
    return "typedData.domain must be an object";
  if (!isPlainObject(typedData.types))
    return "typedData.types must be an object";
  if (
    typeof typedData.primaryType !== "string" ||
    !typedData.primaryType.trim()
  ) {
    return "typedData.primaryType is required";
  }
  if (!isPlainObject(typedData.message))
    return "typedData.message must be an object";
  if (JSON.stringify(typedData).length > 65_536)
    return "eth_signTypedData_v4 typedData is too large";

  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [typeName, fields] of Object.entries(typedData.types)) {
    if (!Array.isArray(fields))
      return `typedData.types.${typeName} must be an array`;
    types[typeName] = [];
    for (const field of fields) {
      if (
        !isPlainObject(field) ||
        typeof field.name !== "string" ||
        typeof field.type !== "string"
      ) {
        return `typedData.types.${typeName} fields must include name and type`;
      }
      types[typeName].push({ name: field.name, type: field.type });
    }
  }
  if (!types[typedData.primaryType])
    return "typedData.types must include primaryType";
  if (typedDataContainsPermit({ primaryType: typedData.primaryType, types })) {
    return "Refusing to sign permit-style typed data";
  }

  const domain = typedData.domain as SignTypedDataRequest["domain"];
  if (
    domain.verifyingContract !== undefined &&
    (typeof domain.verifyingContract !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(domain.verifyingContract))
  ) {
    return "typedData.domain.verifyingContract must be a valid EVM address";
  }
  if (
    domain.chainId !== undefined &&
    (typeof domain.chainId !== "number" ||
      !Number.isSafeInteger(domain.chainId) ||
      domain.chainId <= 0)
  ) {
    return "typedData.domain.chainId must be a positive integer";
  }
  return {
    address,
    domain,
    types,
    primaryType: typedData.primaryType,
    value: typedData.message,
  };
}

function parseRpcQuantity(value: unknown): bigint | string {
  if (value === undefined || value === null || value === "") return 0n;
  if (typeof value !== "string") return "transaction value must be a string";
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed);
  if (/^(0|[1-9][0-9]*)$/.test(trimmed)) return BigInt(trimmed);
  return "transaction value must be a decimal string or 0x quantity";
}

function parseRpcChainId(value: unknown): number | string {
  if (value === undefined || value === null || value === "") {
    return Number(process.env.CHAIN_ID || "84532");
  }
  const parsed = parseRpcQuantity(value);
  if (typeof parsed === "string")
    return "transaction chainId must be a decimal string or 0x quantity";
  const chainId = Number(parsed);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    return "transaction chainId must be a positive safe integer";
  return chainId;
}

function parseSendTransactionParams(value: unknown):
  | {
      from?: string;
      to: string;
      valueWei: string;
      data?: string;
      chainId: number;
    }
  | string {
  if (!Array.isArray(value) || value.length !== 1 || !isPlainObject(value[0])) {
    return "eth_sendTransaction params must be [transaction]";
  }
  const tx = value[0];
  const from = tx.from;
  if (
    from !== undefined &&
    (typeof from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(from))
  ) {
    return "transaction.from must be a valid EVM address";
  }
  if (typeof tx.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) {
    return "transaction.to must be a valid EVM address";
  }
  const valueWei = parseRpcQuantity(tx.value);
  if (typeof valueWei === "string") return valueWei;
  const chainId = parseRpcChainId(tx.chainId);
  if (typeof chainId === "string") return chainId;
  const data = tx.data;
  if (data !== undefined) {
    if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) {
      return "transaction.data must be 0x-prefixed hex";
    }
    if ((data.length - 2) / 2 > MAX_TRANSACTION_DATA_BYTES) {
      return "transaction.data is too large";
    }
  }
  return {
    from,
    to: tx.to,
    valueWei: valueWei.toString(),
    data,
    chainId,
  };
}

function hasRecentMfa(
  c: Context<{ Variables: GlobalWalletVariables }>,
): boolean {
  return isRecentMfaTimestamp(c.get("sessionMfaVerifiedAt"), MFA_MAX_AGE_MS);
}

async function getEnabledAppClient(
  tenantId: string,
  clientId: string,
): Promise<AppClientRow | null> {
  const [client] = await getDb()
    .select()
    .from(tenantAppClients)
    .where(
      and(
        eq(tenantAppClients.tenantId, tenantId),
        eq(tenantAppClients.id, clientId),
        eq(tenantAppClients.enabled, true),
        eq(tenantAppClients.globalWalletEnabled, true),
      ),
    );
  return client ?? null;
}

function validateAppOriginAndRedirect(
  client: AppClientRow,
  origin: string | null,
  redirectUri: string | null,
): string | null {
  if (!origin) return "origin is required";
  if (!(client.allowedOrigins ?? []).includes(origin))
    return "origin is not allowed for this app";
  if (
    redirectUri &&
    !(client.allowedRedirectUrls ?? []).includes(redirectUri)
  ) {
    return "redirect_uri is not allowed for this app";
  }
  return null;
}

async function getUserWalletAddress(
  userId: string,
  walletIndex: number,
): Promise<{
  agentId: string;
  walletAddress: string;
  walletIndex: number;
} | null> {
  const agentId = userWalletAgentId(userId, walletIndex);
  const [wallet] = await getDb()
    .select({ id: agents.id, walletAddress: agents.walletAddress })
    .from(agents)
    .where(
      and(eq(agents.tenantId, `personal-${userId}`), eq(agents.id, agentId)),
    );
  if (!wallet) return null;

  const [evmWallet] = await getDb()
    .select({ address: agentWallets.address })
    .from(agentWallets)
    .where(
      and(
        eq(agentWallets.agentId, agentId),
        eq(agentWallets.chainFamily, "evm"),
        sql`${agentWallets.venue} is null`,
      ),
    );
  return {
    agentId,
    walletAddress: evmWallet?.address ?? wallet.walletAddress,
    walletIndex,
  };
}

function serializeConsent(row: ConsentRow, userId?: string) {
  const walletIndex = userId
    ? walletIndexFromAgentId(userId, row.walletAgentId)
    : null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    clientId: row.clientId,
    appId: `${row.tenantId}/${row.clientId}`,
    origin: row.origin,
    redirectUri: row.redirectUri,
    walletAgentId: row.walletAgentId,
    walletAddress: row.walletAddress,
    walletIndex,
    scopes: row.scopes,
    status: row.status,
    grantedAt: row.grantedAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function writeGlobalWalletAudit(
  c: Context<{ Variables: GlobalWalletVariables }>,
  input: {
    tenantId: string;
    action: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await writeAuditEvent({
    tenantId: input.tenantId,
    actorType: "user",
    actorId: c.get("userId"),
    action: input.action,
    resourceType: "global_wallet_consent",
    resourceId: input.resourceId ?? null,
    metadata: input.metadata,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  });
}

async function activeConsentFor(
  userId: string,
  tenantId: string,
  clientId: string,
  origin: string,
): Promise<ConsentRow | null> {
  const [consent] = await getDb()
    .select()
    .from(userWalletAppConsents)
    .where(
      and(
        eq(userWalletAppConsents.userId, userId),
        eq(userWalletAppConsents.tenantId, tenantId),
        eq(userWalletAppConsents.clientId, clientId),
        eq(userWalletAppConsents.origin, origin),
        eq(userWalletAppConsents.status, "active"),
        sql`(${userWalletAppConsents.expiresAt} is null or ${userWalletAppConsents.expiresAt} > now())`,
      ),
    );
  return consent ?? null;
}

function consentMatchesWallet(
  consent: ConsentRow,
  wallet: { agentId: string; walletAddress: string },
) {
  return (
    consent.walletAgentId === wallet.agentId &&
    (!consent.walletAddress ||
      consent.walletAddress.toLowerCase() ===
        wallet.walletAddress.toLowerCase())
  );
}

async function consumeActionConfirmation(input: {
  confirmationId: unknown;
  consent: ConsentRow;
  userId: string;
  tenantId: string;
  clientId: string;
  origin: string;
  method: string;
  requestHash: string;
}): Promise<string | null> {
  if (
    typeof input.confirmationId !== "string" ||
    !input.confirmationId.trim()
  ) {
    return "Global wallet action confirmation is required";
  }
  const now = new Date();
  const [confirmation] = await getDb()
    .update(globalWalletActionConfirmations)
    .set({ status: "consumed", consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(globalWalletActionConfirmations.id, input.confirmationId),
        eq(globalWalletActionConfirmations.consentId, input.consent.id),
        eq(globalWalletActionConfirmations.userId, input.userId),
        eq(globalWalletActionConfirmations.tenantId, input.tenantId),
        eq(globalWalletActionConfirmations.clientId, input.clientId),
        eq(globalWalletActionConfirmations.origin, input.origin),
        eq(globalWalletActionConfirmations.method, input.method),
        eq(globalWalletActionConfirmations.requestHash, input.requestHash),
        eq(globalWalletActionConfirmations.status, "approved"),
        sql`${globalWalletActionConfirmations.expiresAt} > now()`,
      ),
    )
    .returning({ id: globalWalletActionConfirmations.id });
  return confirmation
    ? null
    : "Global wallet action confirmation is invalid or expired";
}

globalWalletRoutes.get("/consent/request", async (c) => {
  const parsed = parseAppId(c.req.query("app_id") ?? c.req.query("appId"));
  if (!parsed)
    return c.json<ApiResponse>({ ok: false, error: "invalid app_id" }, 400);

  const client = await getEnabledAppClient(parsed.tenantId, parsed.clientId);
  if (!client)
    return c.json<ApiResponse>(
      { ok: false, error: "global wallet is not enabled for this app" },
      404,
    );

  const origin = requestOrigin(c, c.req.query("origin"));
  const redirectUri = normalizeRedirectUri(
    c.req.query("redirect_uri") ?? c.req.query("redirectUri"),
  );
  const validationError = validateAppOriginAndRedirect(
    client,
    origin,
    redirectUri,
  );
  if (validationError)
    return c.json<ApiResponse>({ ok: false, error: validationError }, 400);

  const scopes = parseScopes(
    c.req.queries("scope") ?? c.req.query("scope"),
    client.globalWalletAllowedScopes,
  );
  if (typeof scopes === "string")
    return c.json<ApiResponse>({ ok: false, error: scopes }, 400);

  const walletIndex = parseWalletIndex(
    c.req.query("wallet_index") ?? c.req.query("walletIndex"),
  );
  if (typeof walletIndex === "string") {
    return c.json<ApiResponse>({ ok: false, error: walletIndex }, 400);
  }

  const wallet = await getUserWalletAddress(c.get("userId"), walletIndex);
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found - call POST /user/me/wallet to provision",
      },
      404,
    );
  }

  const activeConsent = await activeConsentFor(
    c.get("userId"),
    parsed.tenantId,
    parsed.clientId,
    requireLoginValue(origin, "origin"),
  );
  const existingConsent =
    activeConsent && consentMatchesWallet(activeConsent, wallet)
      ? activeConsent
      : null;

  return c.json<ApiResponse>({
    ok: true,
    data: {
      app: {
        id: client.id,
        appId: `${client.tenantId}/${client.id}`,
        tenantId: client.tenantId,
        name: client.name,
        environment: client.environment,
        origin,
        redirectUri,
      },
      requestedScopes: scopes,
      wallet: {
        agentId: wallet.agentId,
        address: wallet.walletAddress,
        walletIndex,
      },
      consent: existingConsent
        ? serializeConsent(existingConsent, c.get("userId"))
        : null,
    },
  });
});

globalWalletRoutes.post("/consent/approve", async (c) => {
  if (!hasRecentMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Recent MFA is required to approve global wallet access",
      },
      403,
    );
  }

  const body = await safeJsonParse<{
    app_id?: unknown;
    appId?: unknown;
    origin?: unknown;
    redirect_uri?: unknown;
    redirectUri?: unknown;
    scope?: unknown;
    scopes?: unknown;
    wallet_index?: unknown;
    walletIndex?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON body" }, 400);

  const parsed = parseAppId(body.app_id ?? body.appId);
  if (!parsed)
    return c.json<ApiResponse>({ ok: false, error: "invalid app_id" }, 400);

  const client = await getEnabledAppClient(parsed.tenantId, parsed.clientId);
  if (!client)
    return c.json<ApiResponse>(
      { ok: false, error: "global wallet is not enabled for this app" },
      404,
    );

  const origin = requestOrigin(c, body.origin);
  const redirectUri = normalizeRedirectUri(
    body.redirect_uri ?? body.redirectUri,
  );
  const validationError = validateAppOriginAndRedirect(
    client,
    origin,
    redirectUri,
  );
  if (validationError)
    return c.json<ApiResponse>({ ok: false, error: validationError }, 400);

  const scopes = parseScopes(
    body.scopes ?? body.scope,
    client.globalWalletAllowedScopes,
  );
  if (typeof scopes === "string")
    return c.json<ApiResponse>({ ok: false, error: scopes }, 400);

  const walletIndex = parseWalletIndex(body.wallet_index ?? body.walletIndex);
  if (typeof walletIndex === "string") {
    return c.json<ApiResponse>({ ok: false, error: walletIndex }, 400);
  }

  const wallet = await getUserWalletAddress(c.get("userId"), walletIndex);
  if (!wallet) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "No wallet found - call POST /user/me/wallet to provision",
      },
      404,
    );
  }

  const now = new Date();
  // SEC-212: distinguish server-observed (browser header) origins from
  // self-asserted (non-browser body) origins in the consent audit trail.
  const originSource = isHeaderObservedOrigin(c) ? "header" : "client-asserted";
  await writeGlobalWalletAudit(c, {
    tenantId: parsed.tenantId,
    action: "global_wallet.consent.approve.authorized",
    resourceId: `${parsed.clientId}:${origin}`,
    metadata: {
      clientId: parsed.clientId,
      origin,
      originSource,
      redirectUri,
      scopes,
      walletIndex,
    },
  });

  const revokedAtApprove = await getDb()
    .select()
    .from(userWalletAppConsents)
    .where(
      and(
        eq(userWalletAppConsents.userId, c.get("userId")),
        eq(userWalletAppConsents.tenantId, parsed.tenantId),
        eq(userWalletAppConsents.clientId, parsed.clientId),
        eq(userWalletAppConsents.origin, requireLoginValue(origin, "origin")),
        eq(userWalletAppConsents.status, "active"),
      ),
    );
  const [consent] = await getDb().transaction(async (tx) => {
    await tx
      .update(userWalletAppConsents)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(userWalletAppConsents.userId, c.get("userId")),
          eq(userWalletAppConsents.tenantId, parsed.tenantId),
          eq(userWalletAppConsents.clientId, parsed.clientId),
          eq(userWalletAppConsents.origin, requireLoginValue(origin, "origin")),
          eq(userWalletAppConsents.status, "active"),
        ),
      );
    return tx
      .insert(userWalletAppConsents)
      .values({
        tenantId: parsed.tenantId,
        clientId: parsed.clientId,
        userId: c.get("userId"),
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        origin: requireLoginValue(origin, "origin"),
        redirectUri,
        scopes,
        status: "active",
        grantedAt: now,
        updatedAt: now,
      })
      .returning();
  });

  try {
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.consent.approved",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        originSource,
        redirectUri,
        scopes,
        walletIndex,
      },
    });
  } catch (error) {
    await getDb().transaction(async (tx) => {
      await tx
        .delete(userWalletAppConsents)
        .where(
          and(
            eq(userWalletAppConsents.id, consent.id),
            eq(userWalletAppConsents.userId, c.get("userId")),
          ),
        );
      for (const previous of revokedAtApprove) {
        await tx
          .update(userWalletAppConsents)
          .set({
            status: "active",
            revokedAt: null,
            updatedAt: previous.updatedAt,
          })
          .where(eq(userWalletAppConsents.id, previous.id));
      }
    });
    throw error;
  }

  return c.json<ApiResponse>({
    ok: true,
    data: {
      consent: serializeConsent(consent, c.get("userId")),
      wallet: {
        agentId: wallet.agentId,
        address: wallet.walletAddress,
        walletIndex,
      },
    },
  });
});

globalWalletRoutes.get("/consents", async (c) => {
  const rows = await getDb()
    .select()
    .from(userWalletAppConsents)
    .where(eq(userWalletAppConsents.userId, c.get("userId")))
    .orderBy(sql`${userWalletAppConsents.updatedAt} desc`);
  return c.json<ApiResponse>({
    ok: true,
    data: {
      consents: rows.map((row) => serializeConsent(row, c.get("userId"))),
    },
  });
});

globalWalletRoutes.post("/consents/:id/revoke", async (c) => {
  if (!hasRecentMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Recent MFA is required to revoke global wallet access",
      },
      403,
    );
  }

  const now = new Date();
  const [consent] = await getDb()
    .update(userWalletAppConsents)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(userWalletAppConsents.id, c.req.param("id")),
        eq(userWalletAppConsents.userId, c.get("userId")),
        eq(userWalletAppConsents.status, "active"),
      ),
    )
    .returning();

  if (!consent)
    return c.json<ApiResponse>({ ok: false, error: "Consent not found" }, 404);
  await writeGlobalWalletAudit(c, {
    tenantId: consent.tenantId,
    action: "global_wallet.consent.revoked",
    resourceId: consent.id,
    metadata: { clientId: consent.clientId, origin: consent.origin },
  });
  return c.json<ApiResponse>({
    ok: true,
    data: { consent: serializeConsent(consent, c.get("userId")) },
  });
});

globalWalletRoutes.post("/rpc/confirm", async (c) => {
  if (!hasRecentMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Recent MFA is required to confirm global wallet actions",
      },
      403,
    );
  }

  const body = await safeJsonParse<{
    app_id?: unknown;
    appId?: unknown;
    origin?: unknown;
    method?: unknown;
    params?: unknown;
    wallet_index?: unknown;
    walletIndex?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON body" }, 400);

  const parsed = parseAppId(body.app_id ?? body.appId);
  if (!parsed)
    return c.json<ApiResponse>({ ok: false, error: "invalid app_id" }, 400);
  if (
    typeof body.method !== "string" ||
    !CONFIRMABLE_RPC_METHODS.has(body.method.trim())
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Global wallet action confirmation requires a writable RPC method",
      },
      400,
    );
  }
  const method = body.method.trim();

  const client = await getEnabledAppClient(parsed.tenantId, parsed.clientId);
  if (!client)
    return c.json<ApiResponse>(
      { ok: false, error: "global wallet is not enabled for this app" },
      404,
    );
  const origin = requestOrigin(c, body.origin);
  const validationError = validateAppOriginAndRedirect(client, origin, null);
  if (validationError)
    return c.json<ApiResponse>({ ok: false, error: validationError }, 400);

  const consent = await activeConsentFor(
    c.get("userId"),
    parsed.tenantId,
    parsed.clientId,
    requireLoginValue(origin, "origin"),
  );
  if (!consent)
    return c.json<ApiResponse>(
      { ok: false, error: "Global wallet consent is required" },
      403,
    );
  if (!consent.scopes.includes(method)) {
    return c.json<ApiResponse>(
      { ok: false, error: `Consent does not include ${method}` },
      403,
    );
  }

  const walletIndex = parseWalletIndex(body.wallet_index ?? body.walletIndex);
  if (typeof walletIndex === "string") {
    return c.json<ApiResponse>({ ok: false, error: walletIndex }, 400);
  }
  const wallet = await getUserWalletAddress(c.get("userId"), walletIndex);
  if (!wallet)
    return c.json<ApiResponse>({ ok: false, error: "No wallet found" }, 404);
  if (!consentMatchesWallet(consent, wallet)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Global wallet consent is no longer valid for the current wallet",
      },
      403,
    );
  }

  if (method === "personal_sign") {
    const parsedParams = parsePersonalSignParams(body.params);
    if (typeof parsedParams === "string") {
      const status = parsedParams.startsWith("Refusing") ? 403 : 400;
      return c.json<ApiResponse>({ ok: false, error: parsedParams }, status);
    }
    if (
      parsedParams.address &&
      parsedParams.address.toLowerCase() !== wallet.walletAddress.toLowerCase()
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "personal_sign address does not match the consented wallet",
        },
        403,
      );
    }
  } else if (method === "eth_signTypedData_v4") {
    const parsedParams = parseTypedDataV4Params(body.params);
    if (typeof parsedParams === "string") {
      const status = parsedParams.startsWith("Refusing") ? 403 : 400;
      return c.json<ApiResponse>({ ok: false, error: parsedParams }, status);
    }
    if (
      parsedParams.address?.toLowerCase() !== wallet.walletAddress.toLowerCase()
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "eth_signTypedData_v4 address does not match the consented wallet",
        },
        403,
      );
    }
  } else if (method === "eth_sendTransaction") {
    const parsedTx = parseSendTransactionParams(body.params);
    if (typeof parsedTx === "string")
      return c.json<ApiResponse>({ ok: false, error: parsedTx }, 400);
    if (
      parsedTx.from &&
      parsedTx.from.toLowerCase() !== wallet.walletAddress.toLowerCase()
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "transaction.from does not match the consented wallet",
        },
        403,
      );
    }
    if (parsedTx.data && parsedTx.data !== "0x") {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Contract calldata is not enabled for global wallet transaction confirmations until selector-aware scanning is configured",
        },
        403,
      );
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACTION_CONFIRMATION_TTL_MS);
  const requestHash = globalWalletActionHash({
    method,
    params: body.params,
    walletAgentId: wallet.agentId,
    walletAddress: wallet.walletAddress,
    walletIndex,
  });
  const confirmation = await getDb().transaction(async (tx) => {
    if (
      process.env.STEWARD_DB_MODE !== "pglite" &&
      process.env.STEWARD_PGLITE_MEMORY !== "true"
    ) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`global-wallet-confirmation:${consent.id}:${method}:${requestHash}`}))`,
      );
    }
    const [existing] = await tx
      .select({ id: globalWalletActionConfirmations.id })
      .from(globalWalletActionConfirmations)
      .where(
        and(
          eq(globalWalletActionConfirmations.consentId, consent.id),
          eq(globalWalletActionConfirmations.userId, c.get("userId")),
          eq(globalWalletActionConfirmations.tenantId, parsed.tenantId),
          eq(globalWalletActionConfirmations.clientId, parsed.clientId),
          eq(
            globalWalletActionConfirmations.origin,
            requireLoginValue(origin, "origin"),
          ),
          eq(globalWalletActionConfirmations.method, method),
          eq(globalWalletActionConfirmations.requestHash, requestHash),
          eq(globalWalletActionConfirmations.status, "approved"),
          sql`${globalWalletActionConfirmations.expiresAt} > now()`,
        ),
      )
      .limit(1);
    if (existing) return null;
    const [row] = await tx
      .insert(globalWalletActionConfirmations)
      .values({
        consentId: consent.id,
        tenantId: parsed.tenantId,
        clientId: parsed.clientId,
        userId: c.get("userId"),
        origin: requireLoginValue(origin, "origin"),
        method,
        requestHash,
        status: "approved",
        expiresAt,
        approvedAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  });

  if (!confirmation) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Global wallet action confirmation is already pending",
      },
      409,
    );
  }

  try {
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.rpc.action_confirmed",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        method,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
        confirmationId: confirmation.id,
      },
    });
  } catch (error) {
    await getDb()
      .delete(globalWalletActionConfirmations)
      .where(
        and(
          eq(globalWalletActionConfirmations.id, confirmation.id),
          eq(globalWalletActionConfirmations.userId, c.get("userId")),
        ),
      );
    throw error;
  }

  setNoStoreHeaders(c);
  return c.json<ApiResponse>({
    ok: true,
    data: {
      confirmationId: confirmation.id,
      method,
      wallet: {
        agentId: wallet.agentId,
        address: wallet.walletAddress,
        walletIndex,
      },
      expiresAt: expiresAt.toISOString(),
    },
  });
});

globalWalletRoutes.post("/rpc/scan", async (c) => {
  const body = await safeJsonParse<{
    app_id?: unknown;
    appId?: unknown;
    origin?: unknown;
    method?: unknown;
    params?: unknown;
    wallet_index?: unknown;
    walletIndex?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON body" }, 400);

  const parsed = parseAppId(body.app_id ?? body.appId);
  if (!parsed)
    return c.json<ApiResponse>({ ok: false, error: "invalid app_id" }, 400);
  if (
    typeof body.method !== "string" ||
    !TRANSACTION_SCAN_METHODS.has(body.method.trim())
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Global wallet transaction scan requires eth_sendTransaction",
      },
      400,
    );
  }
  const method = body.method.trim();

  const client = await getEnabledAppClient(parsed.tenantId, parsed.clientId);
  if (!client)
    return c.json<ApiResponse>(
      { ok: false, error: "global wallet is not enabled for this app" },
      404,
    );
  const origin = requestOrigin(c, body.origin);
  const validationError = validateAppOriginAndRedirect(client, origin, null);
  if (validationError)
    return c.json<ApiResponse>({ ok: false, error: validationError }, 400);

  const consent = await activeConsentFor(
    c.get("userId"),
    parsed.tenantId,
    parsed.clientId,
    requireLoginValue(origin, "origin"),
  );
  if (!consent)
    return c.json<ApiResponse>(
      { ok: false, error: "Global wallet consent is required" },
      403,
    );
  if (!consent.scopes.includes(method)) {
    return c.json<ApiResponse>(
      { ok: false, error: `Consent does not include ${method}` },
      403,
    );
  }

  const walletIndex = parseWalletIndex(body.wallet_index ?? body.walletIndex);
  if (typeof walletIndex === "string") {
    return c.json<ApiResponse>({ ok: false, error: walletIndex }, 400);
  }
  const wallet = await getUserWalletAddress(c.get("userId"), walletIndex);
  if (!wallet)
    return c.json<ApiResponse>({ ok: false, error: "No wallet found" }, 404);
  if (!consentMatchesWallet(consent, wallet)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Global wallet consent is no longer valid for the current wallet",
      },
      403,
    );
  }

  const parsedTx = parseSendTransactionParams(body.params);
  if (typeof parsedTx === "string")
    return c.json<ApiResponse>({ ok: false, error: parsedTx }, 400);
  if (
    parsedTx.from &&
    parsedTx.from.toLowerCase() !== wallet.walletAddress.toLowerCase()
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "transaction.from does not match the consented wallet",
      },
      403,
    );
  }

  const hasCalldata = Boolean(parsedTx.data && parsedTx.data !== "0x");
  const warnings = [
    ...(hasCalldata
      ? [
          {
            code: "contract_call_blocked",
            severity: "error",
            message:
              "Contract calldata is not enabled for global wallet transactions until selector-aware scanning is configured.",
          },
        ]
      : []),
    {
      code: "user_confirmation_required",
      severity: "info",
      message:
        "A fresh user confirmation is required before any global wallet transaction can execute.",
    },
  ];
  const blocked = hasCalldata;
  await writeGlobalWalletAudit(c, {
    tenantId: parsed.tenantId,
    action: "global_wallet.rpc.transaction_scanned",
    resourceId: consent.id,
    metadata: {
      clientId: parsed.clientId,
      origin,
      method,
      walletAgentId: wallet.agentId,
      walletAddress: wallet.walletAddress,
      walletIndex,
      to: parsedTx.to,
      valueWei: parsedTx.valueWei,
      chainId: parsedTx.chainId,
      blocked,
      hasCalldata,
    },
  });

  return c.json<ApiResponse>({
    ok: true,
    data: {
      method,
      wallet: {
        address: wallet.walletAddress,
        agentId: wallet.agentId,
        walletIndex,
      },
      transaction: parsedTx,
      blocked,
      riskLevel: blocked
        ? "blocked"
        : parsedTx.valueWei === "0"
          ? "low"
          : "medium",
      warnings,
      confirmationRequired: true,
      executionSupported: ALLOW_GLOBAL_WALLET_SEND_TRANSACTION && !blocked,
      unsupportedReason:
        ALLOW_GLOBAL_WALLET_SEND_TRANSACTION && !blocked
          ? null
          : blocked
            ? "Global wallet transaction execution is disabled for contract calldata until selector-aware scanning is configured."
            : "Global wallet transaction execution is disabled. Set STEWARD_ALLOW_GLOBAL_WALLET_SEND_TRANSACTION=true only after native transfer controls are audited.",
    },
  });
});

globalWalletRoutes.post("/rpc", async (c) => {
  const body = await safeJsonParse<{
    app_id?: unknown;
    appId?: unknown;
    origin?: unknown;
    method?: unknown;
    params?: unknown;
    confirmation_id?: unknown;
    confirmationId?: unknown;
    id?: unknown;
    jsonrpc?: unknown;
    wallet_index?: unknown;
    walletIndex?: unknown;
  }>(c);
  if (!body)
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON body" }, 400);

  const parsed = parseAppId(body.app_id ?? body.appId);
  if (!parsed)
    return c.json<ApiResponse>({ ok: false, error: "invalid app_id" }, 400);
  if (typeof body.method !== "string" || !body.method.trim()) {
    return c.json<ApiResponse>({ ok: false, error: "method is required" }, 400);
  }
  const method = body.method.trim();
  if (
    (SIGNING_RPC_METHODS.has(method) && method !== "eth_sendTransaction") ||
    (method.toLowerCase().includes("sign") && !WRITE_RPC_METHODS.has(method))
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Global wallet signing is not enabled for this method",
      },
      403,
    );
  }
  if (
    !READONLY_RPC_METHODS.has(method) &&
    !WRITE_RPC_METHODS.has(method) &&
    !TRANSACTION_SCAN_METHODS.has(method)
  ) {
    return c.json<ApiResponse>(
      { ok: false, error: `Unsupported global wallet RPC method: ${method}` },
      400,
    );
  }

  const client = await getEnabledAppClient(parsed.tenantId, parsed.clientId);
  if (!client)
    return c.json<ApiResponse>(
      { ok: false, error: "global wallet is not enabled for this app" },
      404,
    );
  const origin = requestOrigin(c, body.origin);
  const validationError = validateAppOriginAndRedirect(client, origin, null);
  if (validationError)
    return c.json<ApiResponse>({ ok: false, error: validationError }, 400);

  const consent = await activeConsentFor(
    c.get("userId"),
    parsed.tenantId,
    parsed.clientId,
    requireLoginValue(origin, "origin"),
  );
  if (!consent)
    return c.json<ApiResponse>(
      { ok: false, error: "Global wallet consent is required" },
      403,
    );
  const requiredScope = WRITE_RPC_METHODS.has(method) ? method : "eth_accounts";
  if (!consent.scopes.includes(requiredScope)) {
    return c.json<ApiResponse>(
      { ok: false, error: `Consent does not include ${requiredScope}` },
      403,
    );
  }

  const walletIndex = parseWalletIndex(body.wallet_index ?? body.walletIndex);
  if (typeof walletIndex === "string") {
    return c.json<ApiResponse>({ ok: false, error: walletIndex }, 400);
  }
  const wallet = await getUserWalletAddress(c.get("userId"), walletIndex);
  if (!wallet)
    return c.json<ApiResponse>({ ok: false, error: "No wallet found" }, 404);
  if (!consentMatchesWallet(consent, wallet)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Global wallet consent is no longer valid for the current wallet",
      },
      403,
    );
  }

  if (method === "personal_sign") {
    if (!ALLOW_UNSAFE_MESSAGE_SIGNING || !ALLOW_GLOBAL_WALLET_PERSONAL_SIGN) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Global wallet personal_sign is disabled. Set STEWARD_ALLOW_UNSAFE_MESSAGE_SIGNING=true and STEWARD_ALLOW_GLOBAL_WALLET_PERSONAL_SIGN=true only for audited compatibility flows.",
        },
        403,
      );
    }
    if (!hasRecentMfa(c)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Recent MFA is required for global wallet personal_sign",
        },
        403,
      );
    }
    const parsedParams = parsePersonalSignParams(body.params);
    if (typeof parsedParams === "string") {
      const status = parsedParams.startsWith("Refusing") ? 403 : 400;
      return c.json<ApiResponse>({ ok: false, error: parsedParams }, status);
    }
    if (
      parsedParams.address &&
      parsedParams.address.toLowerCase() !== wallet.walletAddress.toLowerCase()
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "personal_sign address does not match the consented wallet",
        },
        403,
      );
    }
    const confirmationError = await consumeActionConfirmation({
      confirmationId: body.confirmation_id ?? body.confirmationId,
      consent,
      userId: c.get("userId"),
      tenantId: parsed.tenantId,
      clientId: parsed.clientId,
      origin: requireLoginValue(origin, "origin"),
      method,
      requestHash: globalWalletActionHash({
        method,
        params: body.params,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
      }),
    });
    if (confirmationError)
      return c.json<ApiResponse>({ ok: false, error: confirmationError }, 403);
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.rpc.sign.authorized",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        method,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
        messageLength: parsedParams.message.length,
        confirmationId: body.confirmation_id ?? body.confirmationId,
      },
    });
    let signature: string;
    try {
      signature = await getVault().signMessage(
        `personal-${c.get("userId")}`,
        wallet.agentId,
        parsedParams.message,
      );
    } catch (error) {
      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(error) },
        500,
      );
    }
    await getDb()
      .update(userWalletAppConsents)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(userWalletAppConsents.id, consent.id));
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.rpc.signed",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        method,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
        messageLength: parsedParams.message.length,
        unsafeCompatibilityMode: true,
      },
    });
    setNoStoreHeaders(c);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        jsonrpc: body.jsonrpc ?? "2.0",
        id: body.id ?? null,
        result: signature,
      },
    });
  }

  if (method === "eth_signTypedData_v4") {
    if (!ALLOW_GLOBAL_WALLET_TYPED_DATA_SIGNING) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Global wallet eth_signTypedData_v4 is disabled. Set STEWARD_ALLOW_GLOBAL_WALLET_TYPED_DATA_SIGNING=true only for audited compatibility flows.",
        },
        403,
      );
    }
    if (!hasRecentMfa(c)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Recent MFA is required for global wallet eth_signTypedData_v4",
        },
        403,
      );
    }
    const parsedParams = parseTypedDataV4Params(body.params);
    if (typeof parsedParams === "string") {
      const status = parsedParams.startsWith("Refusing") ? 403 : 400;
      return c.json<ApiResponse>({ ok: false, error: parsedParams }, status);
    }
    if (
      parsedParams.address?.toLowerCase() !== wallet.walletAddress.toLowerCase()
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "eth_signTypedData_v4 address does not match the consented wallet",
        },
        403,
      );
    }
    const confirmationError = await consumeActionConfirmation({
      confirmationId: body.confirmation_id ?? body.confirmationId,
      consent,
      userId: c.get("userId"),
      tenantId: parsed.tenantId,
      clientId: parsed.clientId,
      origin: requireLoginValue(origin, "origin"),
      method,
      requestHash: globalWalletActionHash({
        method,
        params: body.params,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
      }),
    });
    if (confirmationError)
      return c.json<ApiResponse>({ ok: false, error: confirmationError }, 403);
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.rpc.typed_data_sign.authorized",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        method,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
        primaryType: parsedParams.primaryType,
        chainId: parsedParams.domain.chainId ?? null,
        verifyingContract: parsedParams.domain.verifyingContract ?? null,
        confirmationId: body.confirmation_id ?? body.confirmationId,
      },
    });
    let signature: string;
    try {
      signature = await getVault().signTypedData({
        agentId: wallet.agentId,
        tenantId: `personal-${c.get("userId")}`,
        domain: parsedParams.domain,
        types: parsedParams.types,
        primaryType: parsedParams.primaryType,
        value: parsedParams.value,
      });
    } catch (error) {
      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(error) },
        500,
      );
    }
    await getDb()
      .update(userWalletAppConsents)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(userWalletAppConsents.id, consent.id));
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.rpc.typed_data_signed",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        method,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
        primaryType: parsedParams.primaryType,
        chainId: parsedParams.domain.chainId ?? null,
        verifyingContract: parsedParams.domain.verifyingContract ?? null,
        unsafeCompatibilityMode: true,
      },
    });
    setNoStoreHeaders(c);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        jsonrpc: body.jsonrpc ?? "2.0",
        id: body.id ?? null,
        result: signature,
      },
    });
  }

  if (method === "eth_sendTransaction") {
    if (!ALLOW_GLOBAL_WALLET_SEND_TRANSACTION) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Global wallet eth_sendTransaction is disabled. Set STEWARD_ALLOW_GLOBAL_WALLET_SEND_TRANSACTION=true only after native transfer controls are audited.",
        },
        403,
      );
    }
    if (!hasRecentMfa(c)) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "Recent MFA is required for global wallet eth_sendTransaction",
        },
        403,
      );
    }
    const parsedTx = parseSendTransactionParams(body.params);
    if (typeof parsedTx === "string")
      return c.json<ApiResponse>({ ok: false, error: parsedTx }, 400);
    if (
      parsedTx.from &&
      parsedTx.from.toLowerCase() !== wallet.walletAddress.toLowerCase()
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "transaction.from does not match the consented wallet",
        },
        403,
      );
    }
    if (parsedTx.data && parsedTx.data !== "0x") {
      return c.json<ApiResponse>(
        {
          ok: false,
          error:
            "Contract calldata is not enabled for global wallet eth_sendTransaction until selector-aware scanning is configured",
        },
        403,
      );
    }
    const confirmationError = await consumeActionConfirmation({
      confirmationId: body.confirmation_id ?? body.confirmationId,
      consent,
      userId: c.get("userId"),
      tenantId: parsed.tenantId,
      clientId: parsed.clientId,
      origin: requireLoginValue(origin, "origin"),
      method,
      requestHash: globalWalletActionHash({
        method,
        params: body.params,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
      }),
    });
    if (confirmationError)
      return c.json<ApiResponse>({ ok: false, error: confirmationError }, 403);
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.rpc.transaction_submit.authorized",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        method,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
        to: parsedTx.to,
        valueWei: parsedTx.valueWei,
        chainId: parsedTx.chainId,
        nativeOnly: true,
        confirmationId: body.confirmation_id ?? body.confirmationId,
      },
    });
    let txHash: string;
    try {
      txHash = await getVault().signTransaction({
        agentId: wallet.agentId,
        tenantId: `personal-${c.get("userId")}`,
        to: parsedTx.to,
        value: parsedTx.valueWei,
        data: parsedTx.data,
        chainId: parsedTx.chainId,
        walletAddress: wallet.walletAddress,
        broadcast: true,
      });
    } catch (error) {
      return c.json<ApiResponse>(
        { ok: false, error: sanitizeErrorMessage(error) },
        500,
      );
    }
    await getDb()
      .update(userWalletAppConsents)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(eq(userWalletAppConsents.id, consent.id));
    await writeGlobalWalletAudit(c, {
      tenantId: parsed.tenantId,
      action: "global_wallet.rpc.transaction_submitted",
      resourceId: consent.id,
      metadata: {
        clientId: parsed.clientId,
        origin,
        method,
        walletAgentId: wallet.agentId,
        walletAddress: wallet.walletAddress,
        walletIndex,
        to: parsedTx.to,
        valueWei: parsedTx.valueWei,
        chainId: parsedTx.chainId,
        txHash,
        nativeOnly: true,
      },
    });
    setNoStoreHeaders(c);
    return c.json<ApiResponse>({
      ok: true,
      data: {
        jsonrpc: body.jsonrpc ?? "2.0",
        id: body.id ?? null,
        result: txHash,
      },
    });
  }

  await getDb()
    .update(userWalletAppConsents)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(userWalletAppConsents.id, consent.id));
  await writeGlobalWalletAudit(c, {
    tenantId: parsed.tenantId,
    action: "global_wallet.rpc.used",
    resourceId: consent.id,
    metadata: {
      clientId: parsed.clientId,
      origin,
      method,
      walletAgentId: wallet.agentId,
      walletAddress: wallet.walletAddress,
      walletIndex,
    },
  });

  const result =
    method === "eth_accounts"
      ? [wallet.walletAddress]
      : `0x${Number(process.env.CHAIN_ID || "84532").toString(16)}`;
  return c.json<ApiResponse>({
    ok: true,
    data: { jsonrpc: body.jsonrpc ?? "2.0", id: body.id ?? null, result },
  });
});
