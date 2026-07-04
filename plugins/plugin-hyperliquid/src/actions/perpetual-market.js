import { Service } from "@elizaos/core";
import { resolveApiToken, resolveDesktopApiPort } from "@elizaos/shared";
const ACTION_TIMEOUT_MS = 15_000;
export const PERPETUAL_MARKET_SERVICE_TYPE = "perpetual-market";
const HYPERLIQUID_CONTEXTS = ["finance", "crypto", "trading"];
const HYPERLIQUID_ACTION_CONTEXTS = [
    ...HYPERLIQUID_CONTEXTS,
    "payments",
];
const PERPETUAL_MARKET_ACTION_NAME = "PERPETUAL_MARKET";
const HYPERLIQUID_READ_COMPAT_NAME = "HYPERLIQUID_READ";
const HYPERLIQUID_PLACE_ORDER_COMPAT_NAME = "HYPERLIQUID_PLACE_ORDER";
function toCallbackData(data) {
    return data;
}
const READ_KINDS = [
    "status",
    "markets",
    "market",
    "positions",
    "funding",
];
const HYPERLIQUID_OPS = ["read", "place_order"];
const HYPERLIQUID_READ_COMPAT_SIMILES = [
    "HYPERLIQUID",
    "PERP_MARKET",
    HYPERLIQUID_READ_COMPAT_NAME,
    "HYPERLIQUID_STATUS",
    "HYPERLIQUID_READINESS",
    "HYPERLIQUID_HEALTH",
    "HYPERLIQUID_GET_MARKETS",
    "HYPERLIQUID_MARKETS",
    "HYPERLIQUID_GET_MARKET",
    "HYPERLIQUID_MARKET",
    "HYPERLIQUID_GET_POSITIONS",
    "HYPERLIQUID_POSITIONS",
    "HYPERLIQUID_FUNDING",
];
const HYPERLIQUID_PLACE_ORDER_COMPAT_SIMILES = [
    HYPERLIQUID_PLACE_ORDER_COMPAT_NAME,
    "HYPERLIQUID_TRADE",
    "HYPERLIQUID_BUY",
    "HYPERLIQUID_SELL",
    "HYPERLIQUID_LONG",
    "HYPERLIQUID_SHORT",
    // HyperliquidBench Rust plan-step kinds (packages/benchmarks/HyperliquidBench/types.py)
    // — keep these as similes so retrieval/fine-tune transfer covers the bench's vocabulary.
    "HYPERLIQUID_PERP_ORDERS",
    "HYPERLIQUID_CANCEL_LAST",
    "HYPERLIQUID_CANCEL_OIDS",
    "HYPERLIQUID_CANCEL_ALL",
    "HYPERLIQUID_USD_CLASS_TRANSFER",
    "HYPERLIQUID_SET_LEVERAGE",
];
const HYPERLIQUID_READ_OP_ALIASES = new Set([
    ...READ_KINDS,
    ...HYPERLIQUID_READ_COMPAT_SIMILES.map((name) => name.toLowerCase()),
]);
const HYPERLIQUID_PLACE_ORDER_OP_ALIASES = new Set([
    ...HYPERLIQUID_PLACE_ORDER_COMPAT_SIMILES.map((name) => name.toLowerCase()),
    "trade",
    "order",
    "buy",
    "sell",
    "long",
    "short",
]);
const PLACE_ORDER_DISABLED_REASON = "Signed Hyperliquid exchange execution is disabled in the native app. Use the Hyperliquid UI or a dedicated signer to place orders.";
function getApiBase() {
    return `http://127.0.0.1:${resolveDesktopApiPort(process.env)}`;
}
function buildAuthHeaders() {
    const token = resolveApiToken(process.env);
    if (!token)
        return {};
    return {
        Authorization: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`,
    };
}
function readParam(options, key) {
    const maybeOptions = options;
    if (maybeOptions?.parameters && key in maybeOptions.parameters) {
        return maybeOptions.parameters[key];
    }
    return options?.[key];
}
function readStringParam(options, key) {
    const value = readParam(options, key);
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
function readKind(options) {
    const raw = readStringParam(options, "kind");
    if (!raw)
        return null;
    const normalized = raw.toLowerCase();
    return READ_KINDS.includes(normalized)
        ? normalized
        : null;
}
function normalizeOp(value) {
    if (typeof value !== "string")
        return null;
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    if (HYPERLIQUID_OPS.includes(normalized)) {
        return normalized;
    }
    if (HYPERLIQUID_READ_OP_ALIASES.has(normalized)) {
        return "read";
    }
    if (HYPERLIQUID_PLACE_ORDER_OP_ALIASES.has(normalized)) {
        return "place_order";
    }
    return null;
}
function readOp(options) {
    const rawOp = readStringParam(options, "action") ??
        readStringParam(options, "subaction") ??
        readStringParam(options, "op") ??
        readStringParam(options, "operation") ??
        readStringParam(options, "name");
    const explicit = normalizeOp(rawOp);
    if (explicit)
        return explicit;
    if (readKind(options))
        return "read";
    if (readStringParam(options, "side") ||
        readStringParam(options, "coin") ||
        readStringParam(options, "asset") ||
        readParam(options, "size") !== undefined) {
        return "place_order";
    }
    return null;
}
async function fetchHyperliquidJson(path) {
    const response = await fetch(`${getApiBase()}${path}`, {
        headers: { accept: "application/json", ...buildAuthHeaders() },
        signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null));
    if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload
            ? String(payload.error)
            : `Hyperliquid API request failed with ${response.status}`;
        throw new Error(message);
    }
    return payload;
}
async function emit(callback, text, data) {
    if (callback) {
        await callback({
            text,
            actions: [PERPETUAL_MARKET_ACTION_NAME],
            data: toCallbackData(data),
        });
    }
    return {
        success: true,
        text,
        data: { actionName: PERPETUAL_MARKET_ACTION_NAME, ...data },
    };
}
async function emitFailure(callback, text, error, data) {
    if (callback) {
        await callback({
            text,
            actions: [PERPETUAL_MARKET_ACTION_NAME],
            data: toCallbackData(data),
        });
    }
    return { success: false, text, error, data };
}
function marketLine(market) {
    const leverage = market.maxLeverage !== null ? ` maxLeverage ${market.maxLeverage}x` : "";
    const isolated = market.onlyIsolated ? " isolated-only" : "";
    return `- ${market.name}${leverage}${isolated}`;
}
function formatMarkets(markets) {
    if (markets.length === 0)
        return "No active Hyperliquid markets found.";
    const active = markets.filter((m) => !m.isDelisted);
    return `Hyperliquid perpetual markets (${active.length} active):\n${active
        .slice(0, 20)
        .map(marketLine)
        .join("\n")}`;
}
function formatMarket(market) {
    if (!market)
        return "No matching Hyperliquid market found.";
    return [
        `Hyperliquid ${market.name} perpetual`,
        `Status: ${market.isDelisted ? "delisted" : "active"}`,
        `Size decimals: ${market.szDecimals}`,
        `Max leverage: ${market.maxLeverage ?? "n/a"}`,
        `Isolated only: ${market.onlyIsolated ? "yes" : "no"}`,
    ].join("\n");
}
function fundingLine(rate) {
    const premium = rate.premium ? ` premium ${rate.premium}` : "";
    const openInterest = rate.openInterest ? ` OI ${rate.openInterest}` : "";
    const mark = rate.markPx ? ` mark ${rate.markPx}` : "";
    return `- ${rate.coin}: funding ${rate.funding}${premium}${openInterest}${mark}`;
}
function formatFundingRates(rates) {
    if (rates.length === 0)
        return "No Hyperliquid funding rates found.";
    return `Hyperliquid current funding rates:\n${rates
        .slice(0, 20)
        .map(fundingLine)
        .join("\n")}`;
}
async function handleStatus(callback) {
    const status = await fetchHyperliquidJson("/api/hyperliquid/status");
    const text = [
        `Hyperliquid public reads: ${status.publicReadReady ? "ready" : "not ready"}`,
        `Account reads: ${status.readiness.accountReads ? "ready" : "not ready"}`,
        `Signer: ${status.signerReady ? "ready" : "not ready"}`,
        `Execution: disabled`,
        status.executionBlockedReason
            ? `Reason: ${status.executionBlockedReason}`
            : null,
        `Credential mode: ${status.credentialMode}`,
        status.accountAddress ? `Account: ${status.accountAddress}` : null,
    ]
        .filter((line) => Boolean(line))
        .join("\n");
    return emit(callback, text, {
        op: "read",
        compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
        kind: "status",
        status,
    });
}
async function handleMarkets(callback) {
    const response = await fetchHyperliquidJson("/api/hyperliquid/markets");
    return emit(callback, formatMarkets(response.markets), {
        op: "read",
        compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
        kind: "markets",
        markets: response.markets,
        source: response.source,
        fetchedAt: response.fetchedAt,
    });
}
async function handleMarket(options, callback) {
    const coin = readStringParam(options, "coin") ??
        readStringParam(options, "asset") ??
        readStringParam(options, "name") ??
        readStringParam(options, "symbol");
    if (!coin) {
        const text = "Provide a Hyperliquid coin/asset symbol (e.g. BTC, ETH, SOL).";
        return emitFailure(callback, text, "missing_market_identifier", {
            actionName: PERPETUAL_MARKET_ACTION_NAME,
            op: "read",
            compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
            kind: "market",
        });
    }
    const response = await fetchHyperliquidJson("/api/hyperliquid/markets");
    const target = coin.toUpperCase();
    const market = response.markets.find((m) => m.name.toUpperCase() === target) ?? null;
    return emit(callback, formatMarket(market), {
        op: "read",
        compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
        kind: "market",
        market,
        source: response.source,
        fetchedAt: response.fetchedAt,
    });
}
async function handlePositions(callback) {
    const response = await fetchHyperliquidJson("/api/hyperliquid/positions");
    if (!response.accountAddress) {
        const text = response.readBlockedReason
            ? `Hyperliquid positions unavailable: ${response.readBlockedReason}`
            : "Hyperliquid positions unavailable: no account address configured.";
        return emit(callback, text, {
            op: "read",
            compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
            kind: "positions",
            accountAddress: null,
            positions: [],
            readBlockedReason: response.readBlockedReason,
        });
    }
    const text = response.positions.length === 0
        ? `No Hyperliquid positions for ${response.accountAddress}.`
        : `Hyperliquid positions for ${response.accountAddress}:\n${response.positions
            .slice(0, 12)
            .map((position) => `- ${position.coin}: size ${position.size}` +
            (position.entryPx ? ` entry ${position.entryPx}` : "") +
            (position.unrealizedPnl
                ? ` uPnL ${position.unrealizedPnl}`
                : "") +
            (position.leverageValue !== null
                ? ` ${position.leverageType ?? "leverage"} ${position.leverageValue}x`
                : ""))
            .join("\n")}`;
    return emit(callback, text, {
        op: "read",
        compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
        kind: "positions",
        accountAddress: response.accountAddress,
        positions: response.positions,
        fetchedAt: response.fetchedAt,
    });
}
async function handleFunding(options, callback) {
    const coin = readStringParam(options, "coin") ??
        readStringParam(options, "asset") ??
        readStringParam(options, "symbol");
    const response = await fetchHyperliquidJson("/api/hyperliquid/funding");
    const rates = coin
        ? response.rates.filter((rate) => rate.coin.toUpperCase() === coin.toUpperCase())
        : response.rates;
    return emit(callback, formatFundingRates(rates), {
        op: "read",
        compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
        kind: "funding",
        rates,
        source: response.source,
        fetchedAt: response.fetchedAt,
        ...(coin ? { coin } : {}),
    });
}
async function handleReadOperation(options, callback) {
    const kind = readKind(options);
    if (!kind) {
        const text = "Provide kind: status | markets | market | positions | funding.";
        return emitFailure(callback, text, "missing_or_invalid_kind", {
            actionName: PERPETUAL_MARKET_ACTION_NAME,
            op: "read",
            compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
            availableKinds: [...READ_KINDS],
        });
    }
    try {
        switch (kind) {
            case "status":
                return await handleStatus(callback);
            case "markets":
                return await handleMarkets(callback);
            case "market":
                return await handleMarket(options, callback);
            case "positions":
                return await handlePositions(callback);
            case "funding":
                return await handleFunding(options, callback);
        }
    }
    catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return emitFailure(callback, text, text, {
            actionName: PERPETUAL_MARKET_ACTION_NAME,
            op: "read",
            compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
            kind,
        });
    }
}
async function handlePlaceOrderOperation(callback) {
    let status = null;
    try {
        status = await fetchHyperliquidJson("/api/hyperliquid/status");
    }
    catch {
        status = null;
    }
    const reason = status?.executionBlockedReason ?? PLACE_ORDER_DISABLED_REASON;
    const text = `Hyperliquid order placement is disabled.\nReason: ${reason}`;
    return {
        ...(await emit(callback, text, {
            op: "place_order",
            compatActionName: HYPERLIQUID_PLACE_ORDER_COMPAT_NAME,
            trading: {
                enabled: false,
                reason,
                credentialMode: status?.credentialMode ?? "none",
                signerReady: status?.signerReady ?? false,
            },
        })),
        success: false,
        error: reason,
    };
}
async function handleOrders(callback) {
    return await emit(callback, "Hyperliquid open-order reads (kind=orders) are not exposed in this read action; use kind=positions for held perps or the Hyperliquid UI for working orders.", {
        op: "read",
        compatActionName: HYPERLIQUID_READ_COMPAT_NAME,
        kind: "orders",
        notExposed: true,
    });
}
void handleOrders;
void {};
function normalizeProviderKey(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
}
function readTarget(options) {
    return (readStringParam(options, "target") ??
        readStringParam(options, "provider") ??
        "hyperliquid");
}
function createHyperliquidProvider() {
    return {
        name: "hyperliquid",
        aliases: ["hl", "hyperliquid-perps"],
        supportedSubactions: ["read", "place_order"],
        description: "Hyperliquid perpetual market discovery, position reads, and execution readiness.",
        execute: async ({ options, op, callback }) => {
            switch (op) {
                case "read":
                    return await handleReadOperation(options, callback);
                case "place_order":
                    return await handlePlaceOrderOperation(callback);
            }
        },
    };
}
export class PerpetualMarketService extends Service {
    static serviceType = PERPETUAL_MARKET_SERVICE_TYPE;
    capabilityDescription = "Perpetual market provider registry; currently registers Hyperliquid";
    providers = new Map();
    aliases = new Map();
    static async start(runtime) {
        const service = new PerpetualMarketService(runtime);
        service.registerProvider(createHyperliquidProvider());
        return service;
    }
    registerProvider(provider) {
        const key = normalizeProviderKey(provider.name);
        this.providers.set(key, provider);
        for (const alias of [provider.name, ...provider.aliases]) {
            this.aliases.set(normalizeProviderKey(alias), key);
        }
    }
    listProviders() {
        return [...this.providers.values()].map((provider) => ({
            name: provider.name,
            aliases: [...provider.aliases],
            supportedSubactions: [...provider.supportedSubactions],
            description: provider.description,
        }));
    }
    async route(args) {
        const target = args.target ?? "hyperliquid";
        const key = this.aliases.get(normalizeProviderKey(target));
        const provider = key ? this.providers.get(key) : undefined;
        if (!provider) {
            const text = `Unsupported perpetual market provider "${target}".`;
            const data = {
                actionName: PERPETUAL_MARKET_ACTION_NAME,
                error: "UNSUPPORTED_PROVIDER",
                providers: this.listProviders(),
            };
            await args.callback?.({
                text,
                actions: [PERPETUAL_MARKET_ACTION_NAME],
                data: toCallbackData(data),
            });
            return {
                success: false,
                text,
                error: "UNSUPPORTED_PROVIDER",
                data,
            };
        }
        if (!provider.supportedSubactions.includes(args.op)) {
            const text = `${provider.name} does not support ${args.op}.`;
            await args.callback?.({
                text,
                actions: [PERPETUAL_MARKET_ACTION_NAME],
                data: {
                    actionName: PERPETUAL_MARKET_ACTION_NAME,
                    error: "UNSUPPORTED_SUBACTION",
                    provider: provider.name,
                },
            });
            return {
                success: false,
                text,
                error: "UNSUPPORTED_SUBACTION",
                data: {
                    actionName: PERPETUAL_MARKET_ACTION_NAME,
                    provider: provider.name,
                },
            };
        }
        const result = await provider.execute(args);
        return {
            ...result,
            data: {
                ...(result.data ?? {}),
                actionName: PERPETUAL_MARKET_ACTION_NAME,
                target: provider.name,
                supportedProviders: this.listProviders(),
            },
        };
    }
    async stop() {
        this.providers.clear();
        this.aliases.clear();
    }
}
export const perpetualMarketAction = {
    name: "PERPETUAL_MARKET",
    contexts: [...HYPERLIQUID_ACTION_CONTEXTS],
    contextGate: { anyOf: [...HYPERLIQUID_ACTION_CONTEXTS] },
    roleGate: { minRole: "USER" },
    similes: [
        ...HYPERLIQUID_READ_COMPAT_SIMILES,
        ...HYPERLIQUID_PLACE_ORDER_COMPAT_SIMILES,
    ],
    description: "Use registered perpetual market providers. target selects the provider; Hyperliquid is registered today. action=read reads public state with kind: status, markets, market, positions, or funding. action=place_order reports trading readiness; signed order placement is disabled in this read-only app.",
    descriptionCompressed: "Perpetual market router: target hyperliquid; action read or place_order.",
    parameters: [
        {
            name: "target",
            description: "Perpetual market provider.",
            required: false,
            schema: {
                type: "string",
                enum: ["hyperliquid"],
                default: "hyperliquid",
            },
        },
        {
            name: "action",
            description: "Perpetual market operation: read or place_order.",
            required: false,
            schema: { type: "string", enum: ["read", "place_order"] },
        },
        {
            name: "subaction",
            description: "Alias for action (read | place_order | place-order).",
            required: false,
            schema: { type: "string", enum: ["read", "place_order", "place-order"] },
        },
        {
            name: "kind",
            description: "read only: status | markets | market | positions | funding.",
            required: false,
            schema: {
                type: "string",
                enum: ["status", "markets", "market", "positions", "funding"],
            },
        },
        {
            name: "coin",
            description: "market only: Hyperliquid coin/asset symbol (e.g. BTC).",
            required: false,
            schema: { type: "string" },
        },
        {
            name: "side",
            description: "place_order only: intended side, buy or sell.",
            required: false,
            schema: { type: "string", enum: ["buy", "sell"] },
        },
        {
            name: "asset",
            description: "place_order only: Hyperliquid asset symbol.",
            required: false,
            schema: { type: "string" },
        },
        {
            name: "size",
            description: "place_order only: intended order size.",
            required: false,
            schema: { type: "number" },
        },
    ],
    // Applicability is enforced by contextGate. Keep validate non-semantic so
    // planner state-shape drift cannot hide the action after routing selected it.
    validate: async () => true,
    handler: async (runtime, _message, _state, options, callback) => {
        const op = readOp(options);
        if (!op) {
            const text = "Provide action: read | place_order. For read, also provide kind: status | markets | market | positions | funding.";
            return emitFailure(callback, text, "missing_or_invalid_op", {
                actionName: PERPETUAL_MARKET_ACTION_NAME,
                availableActions: [...HYPERLIQUID_OPS],
            });
        }
        const service = runtime.getService(PERPETUAL_MARKET_SERVICE_TYPE);
        if (!service || typeof service.route !== "function") {
            const text = "Perpetual market service is not available.";
            return emitFailure(callback, text, "service_unavailable", {
                actionName: PERPETUAL_MARKET_ACTION_NAME,
            });
        }
        return service.route({
            target: readTarget(options),
            op,
            options,
            callback,
        });
    },
};
export const hyperliquidActions = [perpetualMarketAction];
//# sourceMappingURL=perpetual-market.js.map