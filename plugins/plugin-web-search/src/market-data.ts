/** Read-only source data; retrieval time does not make a price or filing current. */
import {
    type Action,
    ElizaError,
    fetchRemoteMedia,
    type IAgentRuntime,
    type Plugin,
} from "@elizaos/core";

type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ElizaError("The public data provider returned an invalid record.", {
            code: "MARKET_DATA_RESPONSE_INVALID",
        });
    return value as JsonRecord;
}
async function readJson(url: string, signal?: AbortSignal, userAgent?: string) {
    const { buffer } = await fetchRemoteMedia({
        url,
        signal,
        userAgent,
        maxBytes: 20 * 1024 * 1024,
    });
    return object(JSON.parse(buffer.toString("utf8")));
}
const metrics: Record<string, string[]> = {
    revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
    net_income: ["NetIncomeLoss"],
    cash: ["CashAndCashEquivalentsAtCarryingValue"],
    assets: ["Assets"],
    liabilities: ["Liabilities"],
    operating_income: ["OperatingIncomeLoss"],
};

async function company(symbol: string, runtime: IAgentRuntime, signal?: AbortSignal) {
    const userAgent = runtime.getSetting("SEC_USER_AGENT");
    if (typeof userAgent !== "string" || !userAgent.trim())
        throw new ElizaError("Configure SEC_USER_AGENT with your own SEC contact identity.", {
            code: "SEC_USER_AGENT_REQUIRED",
        });
    const catalogUrl = "https://www.sec.gov/files/company_tickers.json";
    const catalog = await readJson(catalogUrl, signal, userAgent);
    const match = Object.values(catalog)
        .map(object)
        .find((row) => row.ticker === symbol);
    if (
        !match ||
        typeof match.cik_str !== "number" ||
        !Number.isSafeInteger(match.cik_str) ||
        match.cik_str <= 0
    )
        throw new ElizaError("SEC did not return a matching company identifier.", {
            code: "SEC_COMPANY_NOT_FOUND",
        });
    return {
        cik: String(match.cik_str).padStart(10, "0"),
        name: match.title,
        symbol,
        catalogUrl,
        userAgent,
        coverage:
            "SEC ticker mapping identifies the filing entity; it does not establish current exchange listing.",
    };
}

function parameters(options: unknown) {
    const values =
        options && typeof options === "object" ? (options as Record<string, unknown>) : {};
    const params = object(values.parameters);
    if (typeof params.symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(params.symbol))
        throw new ElizaError("An exact stock ticker is required.", {
            code: "MARKET_SYMBOL_REQUIRED",
        });
    return {
        params,
        symbol: params.symbol,
        signal: values.abortSignal instanceof AbortSignal ? values.abortSignal : undefined,
    };
}

const symbolParameter = {
    name: "symbol",
    description: "Exact stock ticker; never infer listing from a company name.",
    required: true,
    schema: { type: "string" },
};
function action(
    name: string,
    description: string,
    read: (runtime: IAgentRuntime, options: unknown) => Promise<JsonRecord>,
    extra: Action["parameters"] = []
): Action {
    return {
        name,
        similes: [],
        tags: ["resource:markets", "capability:read"],
        contexts: ["general"],
        roleGate: { minRole: "GUEST" },
        description,
        parameters: [symbolParameter, ...(extra ?? [])],
        validate: async () => true,
        handler: async (runtime, _message, _state, options) => {
            const data = await read(runtime, options);
            const text = JSON.stringify(data);
            return {
                success: true,
                text,
                modelReplyRequired: true,
                data: { actionName: name, ...data, sources: [{ url: data.sourceUrl, text }] },
            };
        },
    };
}

export const stockQuoteAction = action(
    "STOCK_QUOTE",
    "Read a Nasdaq public website snapshot with its actual quote timestamp and delay label. A missing quote time is unavailable; this is not an exchange-feed latency guarantee.",
    async (_runtime, options) => {
        const { symbol, signal } = parameters(options);
        const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`;
        const data = object((await readJson(url, signal, "Mozilla/5.0")).data);
        const primary = object(data.primaryData);
        if (
            data.symbol !== symbol ||
            typeof primary.lastSalePrice !== "string" ||
            typeof primary.lastTradeTimestamp !== "string" ||
            !primary.lastTradeTimestamp.trim()
        )
            throw new ElizaError("Nasdaq did not return a matching timestamped quote.", {
                code: "STOCK_QUOTE_UNAVAILABLE",
            });
        return {
            symbol,
            company: data.companyName,
            lastSalePrice: primary.lastSalePrice,
            sourceTime: primary.lastTradeTimestamp,
            currency: primary.currency,
            providerReportsRealTime: primary.isRealTime,
            marketStatus: data.marketStatus,
            retrievedAt: new Date().toISOString(),
            sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}`,
            coverage:
                "Public website snapshot. Use the source timestamp, currency and real-time flag; retrieval is not the quote time.",
        };
    }
);

export const companyFilingsAction = action(
    "COMPANY_FILINGS",
    "Read SEC recent filing records for an exact ticker. Filing date and report period are distinct; ticker mapping does not prove current exchange listing.",
    async (runtime, options) => {
        const { symbol, signal } = parameters(options);
        const info = await company(symbol, runtime, signal);
        const sourceUrl = `https://data.sec.gov/submissions/CIK${info.cik}.json`;
        const data = await readJson(sourceUrl, signal, info.userAgent);
        return {
            sourceUrl,
            company: {
                cik: info.cik,
                name: info.name,
                symbol,
                catalogUrl: info.catalogUrl,
                coverage: info.coverage,
            },
            filings: object(object(data.filings).recent),
            retrievedAt: new Date().toISOString(),
            coverage:
                "Complete recent-filings table from this response; older submission archives have not been read.",
        };
    }
);

export const companyFinancialsAction = action(
    "COMPANY_FINANCIALS",
    "Read SEC US-GAAP facts with all reported periods and units for one metric. Figures can overlap or be restated; do not sum periods or treat a quarter as a year.",
    async (runtime, options) => {
        const { symbol, signal, params } = parameters(options);
        if (typeof params.metric !== "string" || !Object.hasOwn(metrics, params.metric))
            throw new ElizaError("A supported financial metric is required.", {
                code: "FINANCIAL_METRIC_REQUIRED",
            });
        const info = await company(symbol, runtime, signal);
        const sourceUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${info.cik}.json`;
        const facts = object(
            object((await readJson(sourceUrl, signal, info.userAgent)).facts)["us-gaap"]
        );
        const tag = metrics[params.metric].find((key) => facts[key]);
        if (!tag)
            throw new ElizaError("SEC has no supported observation for that metric.", {
                code: "FINANCIAL_METRIC_UNAVAILABLE",
            });
        return {
            sourceUrl,
            company: {
                cik: info.cik,
                name: info.name,
                symbol,
                catalogUrl: info.catalogUrl,
                coverage: info.coverage,
            },
            metric: params.metric,
            taxonomy: "us-gaap",
            tag,
            fact: object(facts[tag]),
            retrievedAt: new Date().toISOString(),
            coverage:
                "As-reported US-GAAP facts, not standardized or audited here. All units and fiscal observations for the selected tag are retained.",
        };
    },
    [
        {
            name: "metric",
            description: "Financial metric to read.",
            required: true,
            schema: { type: "string", enum: Object.keys(metrics) },
        },
    ]
);

export const publicMarketDataPlugin: Plugin = {
    name: "public-market-data",
    description: "Read-only Nasdaq snapshots and SEC filings/facts.",
    actions: [stockQuoteAction, companyFilingsAction, companyFinancialsAction],
};
export default publicMarketDataPlugin;
