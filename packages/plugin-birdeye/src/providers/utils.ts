import { elizaLogger } from "@elizaos/core";

// Constants
export const BASE_URL = "https://public-api.birdeye.so";

export const CHAIN_KEYWORDS = [
    "solana",
    "ethereum",
    "arbitrum",
    "avalanche",
    "bsc",
    "optimism",
    "polygon",
    "base",
    "zksync",
    "sui",
] as const;

// Types
export type Chain = (typeof CHAIN_KEYWORDS)[number];

export class BirdeyeApiError extends Error {
    constructor(
        public status: number,
        message: string
    ) {
        super(message);
        this.name = "BirdeyeApiError";
    }
}

export interface ApiResponse<T> {
    success: boolean;
    data: T;
    error?: string;
}

// Time-related types and constants
export const TIME_UNITS = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
} as const;

export const TIMEFRAME_KEYWORDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "6h": 21600,
    "12h": 43200,
    "1d": 86400,
    "1w": 604800,
} as const;

export type TimeUnit = keyof typeof TIME_UNITS;
export type Timeframe = keyof typeof TIMEFRAME_KEYWORDS;

// Helper functions
export const extractChain = (text: string): Chain => {
    const chain = CHAIN_KEYWORDS.find((chain) =>
        text.toLowerCase().includes(chain.toLowerCase())
    );
    return (chain || "solana") as Chain;
};

export const extractContractAddresses = (text: string): string[] => {
    const words = text.split(/\s+/);
    const addresses: string[] = [];

    for (const word of words) {
        // Ethereum-like addresses (0x...)
        if (/^0x[a-fA-F0-9]{40}$/i.test(word)) {
            addresses.push(word);
        }
        // Solana addresses (base58, typically 32-44 chars)
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word)) {
            addresses.push(word);
        }
    }
    return addresses;
};

// Time extraction and analysis
export const extractTimeframe = (text: string): Timeframe => {
    // First, check for explicit timeframe mentions
    const timeframe = Object.keys(TIMEFRAME_KEYWORDS).find((tf) =>
        text.toLowerCase().includes(tf.toLowerCase())
    );
    if (timeframe) return timeframe as Timeframe;

    // Check for semantic timeframe hints
    const semanticMap = {
        "short term": "15m",
        "medium term": "1h",
        "long term": "1d",
        intraday: "1h",
        daily: "1d",
        weekly: "1w",
        detailed: "5m",
        quick: "15m",
        overview: "1d",
    } as const;

    for (const [hint, tf] of Object.entries(semanticMap)) {
        if (text.toLowerCase().includes(hint)) {
            return tf as Timeframe;
        }
    }

    // Analyze for time-related words
    if (text.match(/minute|min|minutes/i)) return "15m";
    if (text.match(/hour|hourly|hours/i)) return "1h";
    if (text.match(/day|daily|24h/i)) return "1d";
    if (text.match(/week|weekly/i)) return "1w";

    // Default based on context
    if (text.match(/trade|trades|trading|recent/i)) return "15m";
    if (text.match(/trend|analysis|analyze/i)) return "1h";
    if (text.match(/history|historical|long|performance/i)) return "1d";

    return "1h"; // Default timeframe
};

export const extractTimeRange = (
    text: string
): { start: number; end: number } => {
    const now = Math.floor(Date.now() / 1000);

    // Check for specific date ranges
    const dateRangeMatch = text.match(
        /from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i
    );
    if (dateRangeMatch) {
        const start = new Date(dateRangeMatch[1]).getTime() / 1000;
        const end = new Date(dateRangeMatch[2]).getTime() / 1000;
        return { start, end };
    }

    // Check for relative time expressions
    const timeRegex = /(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/i;
    const match = text.match(timeRegex);
    if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2].toLowerCase() as TimeUnit;
        const start = now - amount * TIME_UNITS[unit];
        return { start, end: now };
    }

    // Check for semantic time ranges
    const semanticRanges: Record<string, number> = {
        today: TIME_UNITS.day,
        "this week": TIME_UNITS.week,
        "this month": TIME_UNITS.month,
        recent: TIME_UNITS.hour * 4,
        latest: TIME_UNITS.hour,
        "last hour": TIME_UNITS.hour,
        "last day": TIME_UNITS.day,
        "last week": TIME_UNITS.week,
        "last month": TIME_UNITS.month,
    };

    for (const [range, duration] of Object.entries(semanticRanges)) {
        if (text.toLowerCase().includes(range)) {
            return { start: now - duration, end: now };
        }
    }

    // Analyze context for appropriate default range
    if (text.match(/trend|analysis|performance/i)) {
        return { start: now - TIME_UNITS.week, end: now }; // 1 week for analysis
    }
    if (text.match(/trade|trades|trading|recent/i)) {
        return { start: now - TIME_UNITS.day, end: now }; // 1 day for trading
    }
    if (text.match(/history|historical|long term/i)) {
        return { start: now - TIME_UNITS.month, end: now }; // 1 month for history
    }

    // Default to last 24 hours
    return { start: now - TIME_UNITS.day, end: now };
};

export const extractLimit = (text: string): number => {
    // Check for explicit limit mentions
    const limitMatch = text.match(
        /\b(show|display|get|fetch|limit)\s+(\d+)\b/i
    );
    if (limitMatch) {
        const limit = parseInt(limitMatch[2]);
        return Math.min(Math.max(limit, 1), 100); // Clamp between 1 and 100
    }

    // Check for semantic limit hints
    if (text.match(/\b(all|everything|full|complete)\b/i)) return 100;
    if (text.match(/\b(brief|quick|summary|overview)\b/i)) return 5;
    if (text.match(/\b(detailed|comprehensive)\b/i)) return 50;

    // Default based on context
    if (text.match(/\b(trade|trades|trading)\b/i)) return 10;
    if (text.match(/\b(analysis|analyze|trend)\b/i)) return 24;
    if (text.match(/\b(history|historical)\b/i)) return 50;

    return 10; // Default limit
};

// Formatting helpers
export const formatValue = (value: number): string => {
    if (value >= 1_000_000_000) {
        return `$${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
        return `$${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `$${(value / 1_000).toFixed(2)}K`;
    }
    return `$${value.toFixed(2)}`;
};

export const formatPercentChange = (change?: number): string => {
    if (change === undefined) return "N/A";
    const symbol = change >= 0 ? "📈" : "📉";
    return `${symbol} ${Math.abs(change).toFixed(2)}%`;
};

export const shortenAddress = (address: string): string => {
    if (!address || address.length <= 12) return address || "Unknown";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

export const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString();
};

export const formatPrice = (price: number): string => {
    return price < 0.01 ? price.toExponential(2) : price.toFixed(2);
};

// API helpers
export async function makeApiRequest<T>(
    url: string,
    options: {
        apiKey: string;
        chain: Chain;
        method?: "GET" | "POST";
        body?: any;
    }
): Promise<T> {
    const { apiKey, chain, method = "GET", body } = options;

    try {
        const response = await fetch(url, {
            method,
            headers: {
                "X-API-KEY": apiKey,
                "x-chain": chain,
                ...(body && { "Content-Type": "application/json" }),
            },
            ...(body && { body: JSON.stringify(body) }),
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new BirdeyeApiError(404, "Resource not found");
            }
            if (response.status === 429) {
                throw new BirdeyeApiError(429, "Rate limit exceeded");
            }
            throw new BirdeyeApiError(
                response.status,
                `HTTP error! status: ${response.status}`
            );
        }

        const data: ApiResponse<T> = await response.json();

        if (!data.success) {
            throw new Error(data.error || "Unknown API error");
        }

        return data.data;
    } catch (error) {
        if (error instanceof BirdeyeApiError) {
            elizaLogger.error(`API Error (${error.status}):`, error.message);
        } else {
            elizaLogger.error("Error making API request:", error);
        }
        throw error;
    }
}
