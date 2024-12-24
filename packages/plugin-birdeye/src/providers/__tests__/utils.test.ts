import {
    extractChain,
    extractContractAddresses,
    extractLimit,
    extractTimeframe,
    extractTimeRange,
    formatPercentChange,
    formatPrice,
    formatTimestamp,
    formatValue,
    shortenAddress,
    TIME_UNITS,
} from "../utils";

describe("Chain Extraction", () => {
    test("extracts chain from text correctly", () => {
        expect(extractChain("Check price on Solana")).toBe("solana");
        expect(extractChain("Look up Ethereum token")).toBe("ethereum");
        expect(extractChain("No chain mentioned")).toBe("solana"); // default
    });
});

describe("Contract Address Extraction", () => {
    test("extracts Ethereum addresses correctly", () => {
        const text =
            "Token address is 0x1234567890123456789012345678901234567890";
        expect(extractContractAddresses(text)).toEqual([
            "0x1234567890123456789012345678901234567890",
        ]);
    });

    test("extracts Solana addresses correctly", () => {
        const text =
            "Token address is TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        expect(extractContractAddresses(text)).toEqual([
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ]);
    });

    test("extracts multiple addresses correctly", () => {
        const text =
            "0x1234567890123456789012345678901234567890 TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        expect(extractContractAddresses(text)).toHaveLength(2);
    });
});

describe("Timeframe Extraction", () => {
    test("extracts explicit timeframes correctly", () => {
        expect(extractTimeframe("Show 1h chart")).toBe("1h");
        expect(extractTimeframe("Display 15m data")).toBe("15m");
        expect(extractTimeframe("Get 1d overview")).toBe("1d");
    });

    test("extracts semantic timeframes correctly", () => {
        expect(extractTimeframe("Show short term analysis")).toBe("15m");
        expect(extractTimeframe("Get medium term view")).toBe("1h");
        expect(extractTimeframe("Display long term data")).toBe("1d");
    });

    test("returns default timeframe for unclear input", () => {
        expect(extractTimeframe("Show me the data")).toBe("1h");
    });
});

describe("Time Range Extraction", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("extracts specific date ranges", () => {
        const result = extractTimeRange("from 2023-12-01 to 2023-12-31");
        expect(result.start).toBe(new Date("2023-12-01").getTime() / 1000);
        expect(result.end).toBe(new Date("2023-12-31").getTime() / 1000);
    });

    test("extracts relative time ranges", () => {
        const now = Math.floor(Date.now() / 1000);
        const result = extractTimeRange("24 hours ago");
        expect(result.end).toBe(now);
        expect(result.start).toBe(now - TIME_UNITS.day);
    });

    test("handles semantic time ranges", () => {
        const now = Math.floor(Date.now() / 1000);
        const result = extractTimeRange("show me today's data");
        expect(result.end).toBe(now);
        expect(result.start).toBe(now - TIME_UNITS.day);
    });
});

describe("Limit Extraction", () => {
    test("extracts explicit limits", () => {
        expect(extractLimit("show 20 results")).toBe(20);
        expect(extractLimit("display 5 items")).toBe(5);
        expect(extractLimit("fetch 200 records")).toBe(100); // clamped to max
    });

    test("extracts semantic limits", () => {
        expect(extractLimit("show me everything")).toBe(100);
        expect(extractLimit("give me a brief overview")).toBe(5);
        expect(extractLimit("provide detailed analysis")).toBe(50);
    });

    test("returns default limit for unclear input", () => {
        expect(extractLimit("show me the data")).toBe(10);
    });
});

describe("Formatting Functions", () => {
    test("formats values correctly", () => {
        expect(formatValue(1500000000)).toBe("$1.50B");
        expect(formatValue(1500000)).toBe("$1.50M");
        expect(formatValue(1500)).toBe("$1.50K");
        expect(formatValue(150)).toBe("$150.00");
    });

    test("formats percent changes correctly", () => {
        expect(formatPercentChange(10.5)).toBe("📈 10.50%");
        expect(formatPercentChange(-5.25)).toBe("📉 5.25%");
        expect(formatPercentChange(undefined)).toBe("N/A");
    });

    test("shortens addresses correctly", () => {
        expect(
            shortenAddress("0x1234567890123456789012345678901234567890")
        ).toBe("0x1234...7890");
        expect(shortenAddress("short")).toBe("short");
        expect(shortenAddress("")).toBe("Unknown");
    });

    test("formats timestamps correctly", () => {
        const timestamp = 1704067200; // 2024-01-01 00:00:00 UTC
        expect(formatTimestamp(timestamp)).toMatch(/2024/);
    });

    test("formats prices correctly", () => {
        expect(formatPrice(123.456)).toBe("123.46");
        expect(formatPrice(0.000123)).toBe("1.23e-4");
    });
});
