import { sendJson, sendJsonError } from "@elizaos/app-core/api/response";
import { logger } from "@elizaos/core";
import { HYPERLIQUID_ACCOUNT_BLOCKED_REASON, HYPERLIQUID_API_BASE, HYPERLIQUID_API_WALLET_GUIDANCE, HYPERLIQUID_EXECUTION_BLOCKED_REASON, HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON, HYPERLIQUID_LOCAL_KEY_GUIDANCE, HYPERLIQUID_VAULT_GUIDANCE, } from "./hyperliquid-contracts";
const HEX_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const HEX_PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const STEWARD_EVM_ADDRESS_ENV_KEY = "STEWARD_EVM_ADDRESS";
const MANAGED_EVM_ADDRESS_ENV_KEY = "ELIZA_MANAGED_EVM_ADDRESS";
export async function handleHyperliquidRoute(_req, res, pathname, method, state = {}) {
    if (!pathname.startsWith("/api/hyperliquid"))
        return false;
    const env = state.env ?? process.env;
    const fetchImpl = state.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    const now = state.now ?? (() => new Date());
    const config = resolveHyperliquidConfig(env);
    if (method !== "GET") {
        const payload = {
            executionReady: false,
            executionBlockedReason: config.executionBlockedReason ?? HYPERLIQUID_EXECUTION_BLOCKED_REASON,
            credentialMode: config.credentialMode,
        };
        sendJson(res, 501, payload);
        return true;
    }
    if (pathname === "/api/hyperliquid/status") {
        const payload = {
            publicReadReady: Boolean(fetchImpl),
            signerReady: config.signerReady,
            executionReady: config.executionReady,
            executionBlockedReason: config.executionBlockedReason,
            accountAddress: config.accountAddress,
            apiBaseUrl: config.apiBaseUrl,
            credentialMode: config.credentialMode,
            readiness: {
                publicReads: Boolean(fetchImpl),
                accountReads: Boolean(config.accountAddress),
                signer: config.signerReady,
                execution: false,
            },
            account: {
                address: config.accountAddress,
                source: config.accountSource,
                guidance: config.accountBlockedReason,
            },
            vault: {
                ...config.vault,
                guidance: HYPERLIQUID_VAULT_GUIDANCE,
            },
            apiWallet: config.apiWallet,
        };
        sendJson(res, 200, payload);
        return true;
    }
    if (!fetchImpl) {
        sendJsonError(res, 503, "Fetch API is unavailable for Hyperliquid reads");
        return true;
    }
    const client = createHyperliquidInfoClient({
        fetchImpl,
        apiBaseUrl: config.apiBaseUrl,
    });
    if (pathname === "/api/hyperliquid/markets") {
        try {
            const payload = {
                markets: await client.getMarkets(),
                source: "hyperliquid-info-meta",
                fetchedAt: now().toISOString(),
            };
            sendJson(res, 200, payload);
        }
        catch (error) {
            logger.error({ error: describeError(error) }, "[HyperliquidRoutes] Market fetch failed");
            sendJsonError(res, 502, "Hyperliquid market fetch failed");
        }
        return true;
    }
    if (pathname === "/api/hyperliquid/funding") {
        try {
            const payload = {
                rates: await client.getFundingRates(),
                source: "hyperliquid-info-meta-and-asset-ctxs",
                fetchedAt: now().toISOString(),
            };
            sendJson(res, 200, payload);
        }
        catch (error) {
            logger.error({ error: describeError(error) }, "[HyperliquidRoutes] Funding-rate fetch failed");
            sendJsonError(res, 502, "Hyperliquid funding-rate fetch failed");
        }
        return true;
    }
    if (pathname === "/api/hyperliquid/positions") {
        if (!config.accountAddress) {
            const payload = {
                accountAddress: null,
                positions: [],
                summary: null,
                readBlockedReason: config.accountBlockedReason,
                fetchedAt: null,
            };
            sendJson(res, 200, payload);
            return true;
        }
        try {
            const snapshot = await client.getPositions(config.accountAddress);
            const payload = {
                accountAddress: config.accountAddress,
                positions: snapshot.positions,
                summary: snapshot.summary,
                readBlockedReason: null,
                fetchedAt: now().toISOString(),
            };
            sendJson(res, 200, payload);
        }
        catch (error) {
            logger.error({ error: describeError(error), accountAddress: config.accountAddress }, "[HyperliquidRoutes] Position fetch failed");
            sendJsonError(res, 502, "Hyperliquid position fetch failed");
        }
        return true;
    }
    if (pathname === "/api/hyperliquid/orders") {
        if (!config.accountAddress) {
            const payload = {
                accountAddress: null,
                orders: [],
                readBlockedReason: config.accountBlockedReason,
                fetchedAt: null,
            };
            sendJson(res, 200, payload);
            return true;
        }
        try {
            const payload = {
                accountAddress: config.accountAddress,
                orders: await client.getOpenOrders(config.accountAddress),
                readBlockedReason: null,
                fetchedAt: now().toISOString(),
            };
            sendJson(res, 200, payload);
        }
        catch (error) {
            logger.error({ error: describeError(error), accountAddress: config.accountAddress }, "[HyperliquidRoutes] Order fetch failed");
            sendJsonError(res, 502, "Hyperliquid order fetch failed");
        }
        return true;
    }
    return false;
}
export function createHyperliquidInfoClient({ fetchImpl, apiBaseUrl = HYPERLIQUID_API_BASE, }) {
    async function infoRequest(body) {
        const response = await fetchImpl(`${apiBaseUrl}/info`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`Hyperliquid Info API ${response.status}: ${text.slice(0, 200)}`);
        }
        return (await response.json());
    }
    return {
        async getMarkets() {
            const meta = await infoRequest({ type: "meta" });
            return parseMarkets(meta);
        },
        async getFundingRates() {
            const metaAndCtxs = await infoRequest({
                type: "metaAndAssetCtxs",
            });
            return parseFundingRates(metaAndCtxs);
        },
        async getPositions(accountAddress) {
            const state = await infoRequest({
                type: "clearinghouseState",
                user: accountAddress,
            });
            return parseClearinghouseState(state);
        },
        async getOpenOrders(accountAddress) {
            const orders = await infoRequest({
                type: "openOrders",
                user: accountAddress,
            });
            return parseOrders(orders);
        },
    };
}
function resolveHyperliquidConfig(env) {
    const managedVaultAddress = readFirstValidAddress(env, [
        STEWARD_EVM_ADDRESS_ENV_KEY,
        MANAGED_EVM_ADDRESS_ENV_KEY,
    ]);
    const managedVaultConfigured = Boolean(managedVaultAddress) ||
        Boolean(readEnvString(env, "STEWARD_API_URL")) ||
        readEnvString(env, "ELIZA_WALLET_BACKEND") === "steward";
    const managedVaultReady = Boolean(managedVaultAddress);
    const rawAccount = readEnvString(env, "HYPERLIQUID_ACCOUNT_ADDRESS") ??
        readEnvString(env, "HL_ACCOUNT_ADDRESS");
    const envAccountAddress = rawAccount && HEX_ADDRESS_PATTERN.test(rawAccount) ? rawAccount : null;
    const accountAddress = managedVaultAddress ?? envAccountAddress;
    const accountSource = managedVaultAddress
        ? "managed_vault"
        : envAccountAddress
            ? "env_account"
            : "none";
    const accountBlockedReason = accountAddress
        ? null
        : rawAccount
            ? "HYPERLIQUID_ACCOUNT_ADDRESS / HL_ACCOUNT_ADDRESS must be a 0x-prefixed EVM address."
            : HYPERLIQUID_ACCOUNT_BLOCKED_REASON;
    const privateKey = readFirstValidPrivateKey(env, [
        "EVM_PRIVATE_KEY",
        "HYPERLIQUID_PRIVATE_KEY",
        "HL_PRIVATE_KEY",
    ]);
    const localKeyReady = Boolean(privateKey);
    const signerReady = managedVaultReady || localKeyReady;
    const credentialMode = resolveCredentialMode({
        managedVaultReady,
        localKeyReady,
    });
    const apiWalletConfigured = Boolean(readFirstValidPrivateKey(env, ["HYPERLIQUID_AGENT_KEY", "HL_AGENT_KEY"]));
    return {
        apiBaseUrl: HYPERLIQUID_API_BASE,
        accountAddress,
        accountSource,
        accountBlockedReason,
        credentialMode,
        signerReady,
        executionReady: false,
        executionBlockedReason: signerReady
            ? HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON
            : HYPERLIQUID_EXECUTION_BLOCKED_REASON,
        vault: {
            configured: managedVaultConfigured,
            ready: managedVaultReady,
            address: managedVaultAddress,
        },
        apiWallet: {
            configured: apiWalletConfigured,
            guidance: apiWalletConfigured
                ? HYPERLIQUID_API_WALLET_GUIDANCE
                : `${HYPERLIQUID_API_WALLET_GUIDANCE} ${HYPERLIQUID_LOCAL_KEY_GUIDANCE}`,
        },
    };
}
function resolveCredentialMode({ managedVaultReady, localKeyReady, }) {
    if (managedVaultReady)
        return "managed_vault";
    if (localKeyReady)
        return "local_key";
    return "none";
}
function readFirstValidAddress(env, keys) {
    for (const key of keys) {
        const value = readEnvString(env, key);
        if (value && HEX_ADDRESS_PATTERN.test(value))
            return value;
    }
    return null;
}
function readFirstValidPrivateKey(env, keys) {
    for (const key of keys) {
        const value = readEnvString(env, key);
        if (value && HEX_PRIVATE_KEY_PATTERN.test(value))
            return value;
    }
    return null;
}
function readEnvString(env, key) {
    const value = env[key]?.trim();
    return value ? value : undefined;
}
function parseMarkets(value) {
    const record = asRecord(value, "Hyperliquid meta response");
    const universe = record.universe;
    if (!Array.isArray(universe)) {
        throw new Error("Hyperliquid meta response missing universe");
    }
    return universe.map((entry, index) => {
        const item = asRecord(entry, "Hyperliquid universe entry");
        return {
            name: readRequiredString(item, "name"),
            index,
            szDecimals: readRequiredNumber(item, "szDecimals"),
            maxLeverage: readOptionalNumber(item, "maxLeverage"),
            onlyIsolated: readOptionalBoolean(item, "onlyIsolated") ?? false,
            isDelisted: readOptionalBoolean(item, "isDelisted") ?? false,
        };
    });
}
function parseFundingRates(value) {
    if (!Array.isArray(value) || value.length < 2) {
        throw new Error("Hyperliquid metaAndAssetCtxs response must be a pair");
    }
    const markets = parseMarkets(value[0]);
    const contexts = value[1];
    if (!Array.isArray(contexts)) {
        throw new Error("Hyperliquid metaAndAssetCtxs response missing contexts");
    }
    return contexts.map((entry, index) => {
        const context = asRecord(entry, "Hyperliquid asset context");
        const market = markets[index];
        if (!market) {
            throw new Error(`Hyperliquid asset context ${index} has no market`);
        }
        return {
            coin: market.name,
            index,
            funding: readRequiredString(context, "funding"),
            premium: readOptionalString(context, "premium"),
            markPx: readOptionalString(context, "markPx"),
            oraclePx: readOptionalString(context, "oraclePx"),
            openInterest: readOptionalString(context, "openInterest"),
        };
    });
}
function parsePositions(assetPositions) {
    return assetPositions.map((entry) => {
        const item = asRecord(entry, "Hyperliquid asset position entry");
        const position = asRecord(item.position, "Hyperliquid position");
        const leverage = position.leverage === undefined
            ? null
            : asRecord(position.leverage, "Hyperliquid leverage");
        const size = readRequiredString(position, "szi");
        const positionValue = readOptionalString(position, "positionValue");
        const liquidationPx = readOptionalString(position, "liquidationPx");
        const markPx = computeMarkPx(positionValue, size);
        return {
            coin: readRequiredString(position, "coin"),
            size,
            entryPx: readOptionalString(position, "entryPx"),
            positionValue,
            unrealizedPnl: readOptionalString(position, "unrealizedPnl"),
            returnOnEquity: readOptionalString(position, "returnOnEquity"),
            liquidationPx,
            marginUsed: readOptionalString(position, "marginUsed"),
            leverageType: leverage ? readOptionalString(leverage, "type") : null,
            leverageValue: leverage ? readOptionalNumber(leverage, "value") : null,
            markPx: markPx === null ? null : String(markPx),
            distanceToLiquidationPct: computeDistanceToLiquidationPct(markPx, liquidationPx, size),
        };
    });
}
/**
 * Current mark price = |positionValue| / |size|. Hyperliquid's clearinghouse
 * snapshot already carries the live position value, so the mark is derivable
 * without a second markets fetch. Null when either input is unreadable or the
 * size is effectively zero.
 */
function computeMarkPx(positionValue, size) {
    if (positionValue === null)
        return null;
    const value = Number(positionValue);
    const szi = Number(size);
    if (!Number.isFinite(value) || !Number.isFinite(szi))
        return null;
    if (Math.abs(szi) < 1e-12)
        return null;
    return Math.abs(value) / Math.abs(szi);
}
/**
 * Distance from the current mark to the liquidation price as a percent of mark.
 * Longs liquidate below mark ((mark - liq) / mark); shorts above ((liq - mark)
 * / mark). The position side is read from `size` (negative szi = short). Uses
 * the real mark, not the entry price. Null when mark/liq are unreadable.
 */
function computeDistanceToLiquidationPct(markPx, liquidationPx, size) {
    if (markPx === null || liquidationPx === null)
        return null;
    const liq = Number(liquidationPx);
    const szi = Number(size);
    if (!Number.isFinite(markPx) ||
        !Number.isFinite(liq) ||
        !Number.isFinite(szi) ||
        markPx <= 0) {
        return null;
    }
    const isLong = szi >= 0;
    const distance = isLong ? (markPx - liq) / markPx : (liq - markPx) / markPx;
    return distance * 100;
}
/**
 * Sum each position's `unrealizedPnl` (stringified USD) into a single
 * aggregate, returned as a fixed-2 string so the AppView renders one honest
 * "unrealized PnL" hero stat. Returns null when no position carries a
 * parseable PnL (e.g. a freshly funded account with no open positions).
 */
function sumUnrealizedPnl(positions) {
    let total = 0;
    let seen = false;
    for (const position of positions) {
        if (position.unrealizedPnl === null)
            continue;
        const value = Number(position.unrealizedPnl);
        if (!Number.isFinite(value))
            continue;
        total += value;
        seen = true;
    }
    return seen ? total.toFixed(2) : null;
}
function parseAccountSummary(positions, marginSummary, withdrawable) {
    const accountValue = marginSummary
        ? readOptionalString(marginSummary, "accountValue")
        : null;
    const totalNotionalPosition = marginSummary
        ? readOptionalString(marginSummary, "totalNtlPos")
        : null;
    return {
        accountValue,
        totalNotionalPosition,
        totalMarginUsed: marginSummary
            ? readOptionalString(marginSummary, "totalMarginUsed")
            : null,
        totalRawUsd: marginSummary
            ? readOptionalString(marginSummary, "totalRawUsd")
            : null,
        withdrawable,
        totalUnrealizedPnl: sumUnrealizedPnl(positions),
        effectiveLeverage: computeEffectiveLeverage(totalNotionalPosition, accountValue),
    };
}
/**
 * Effective account leverage = totalNotionalPosition / accountValue, computed
 * server-side so the view only renders the number. Null when either input is
 * unreadable or account value is non-positive.
 */
function computeEffectiveLeverage(totalNotionalPosition, accountValue) {
    if (totalNotionalPosition === null || accountValue === null)
        return null;
    const notional = Number(totalNotionalPosition);
    const value = Number(accountValue);
    if (!Number.isFinite(notional) || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return notional / value;
}
function parseClearinghouseState(value) {
    const record = asRecord(value, "Hyperliquid clearinghouseState response");
    const assetPositions = record.assetPositions;
    if (!Array.isArray(assetPositions)) {
        throw new Error("Hyperliquid clearinghouseState missing assetPositions");
    }
    const positions = parsePositions(assetPositions);
    const marginSummary = record.marginSummary === undefined || record.marginSummary === null
        ? null
        : asRecord(record.marginSummary, "Hyperliquid marginSummary");
    const withdrawable = readOptionalString(record, "withdrawable");
    return {
        positions,
        summary: parseAccountSummary(positions, marginSummary, withdrawable),
    };
}
function parseOrders(value) {
    if (!Array.isArray(value)) {
        throw new Error("Hyperliquid openOrders response must be an array");
    }
    return value.map((entry) => {
        const item = asRecord(entry, "Hyperliquid open order");
        return {
            coin: readRequiredString(item, "coin"),
            side: readRequiredString(item, "side"),
            limitPx: readRequiredString(item, "limitPx"),
            size: readRequiredString(item, "sz"),
            oid: readRequiredNumber(item, "oid"),
            timestamp: readRequiredNumber(item, "timestamp"),
            reduceOnly: readOptionalBoolean(item, "reduceOnly") ?? false,
            orderType: readOptionalString(item, "orderType"),
            tif: readOptionalString(item, "tif"),
            cloid: readOptionalString(item, "cloid"),
        };
    });
}
function asRecord(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}
function readRequiredString(value, key) {
    const field = value[key];
    if (typeof field !== "string") {
        throw new Error(`${key} must be a string`);
    }
    return field;
}
function readOptionalString(value, key) {
    const field = value[key];
    return typeof field === "string" ? field : null;
}
function readRequiredNumber(value, key) {
    const field = value[key];
    if (typeof field !== "number" || !Number.isFinite(field)) {
        throw new Error(`${key} must be a finite number`);
    }
    return field;
}
function readOptionalNumber(value, key) {
    const field = value[key];
    return typeof field === "number" && Number.isFinite(field) ? field : null;
}
function readOptionalBoolean(value, key) {
    const field = value[key];
    return typeof field === "boolean" ? field : null;
}
function describeError(error) {
    if (error instanceof Error) {
        return { message: error.message };
    }
    return { message: String(error) };
}
//# sourceMappingURL=routes.js.map