import { IAgentRuntime, Memory, State } from "@elizaos/core";
import { priceProvider } from "../price-provider";

// Mock data
const mockPriceData = {
    price: 1.23,
    timestamp: 1704067200, // 2024-01-01 00:00:00 UTC
    token: "TEST",
    priceChange24h: 0.05,
    priceChange24hPercent: 4.23,
};

// Mock fetch globally
global.fetch = jest.fn();

describe("Price Provider", () => {
    let mockRuntime: IAgentRuntime;
    let mockMessage: Memory;
    let mockState: State;

    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();

        // Mock runtime
        mockRuntime = {
            getSetting: jest.fn().mockReturnValue("mock-api-key"),
        } as unknown as IAgentRuntime;

        // Mock message
        mockMessage = {
            content: {
                text: "What is the price of 0x1234567890123456789012345678901234567890 on ethereum",
            },
        } as Memory;

        // Mock state
        mockState = {} as State;

        // Mock successful fetch response
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({ data: mockPriceData }),
        });
    });

    test("returns null when API key is missing", async () => {
        (mockRuntime.getSetting as jest.Mock).mockReturnValue(null);
        const result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("returns null when message does not contain price keywords", async () => {
        mockMessage.content.text = "random message without price keywords";
        const result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("returns null when no contract address is found", async () => {
        mockMessage.content.text = "what is the price of invalid-address";
        const result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("handles API error gracefully", async () => {
        (global.fetch as jest.Mock).mockRejectedValue(new Error("API Error"));
        const result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("handles 404 response gracefully", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: false,
            status: 404,
        });
        const result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("formats price response correctly with all data", async () => {
        const result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );

        expect(result).toContain(
            `Price for ${mockPriceData.token} on Ethereum`
        );
        expect(result).toContain(
            `Current Price: $${mockPriceData.price.toFixed(2)}`
        );
        expect(result).toContain(
            `24h Change: $${mockPriceData.priceChange24h.toFixed(2)}`
        );
        expect(result).toContain(
            `24h Change %: ${mockPriceData.priceChange24hPercent.toFixed(2)}%`
        );
        expect(result).toContain("Last Updated:");
    });

    test("formats price response correctly with minimal data", async () => {
        const minimalPriceData = {
            price: 0.000123,
            timestamp: 1704067200,
            token: "TEST",
        };

        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({ data: minimalPriceData }),
        });

        const result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );

        expect(result).toContain(
            `Price for ${minimalPriceData.token} on Ethereum`
        );
        expect(result).toContain("Current Price: $1.23e-4"); // Scientific notation for small numbers
        expect(result).not.toContain("24h Change:");
        expect(result).not.toContain("24h Change %:");
        expect(result).toContain("Last Updated:");
    });

    test("extracts chain correctly", async () => {
        mockMessage.content.text =
            "what is the price of 0x1234567890123456789012345678901234567890 on ethereum";
        await priceProvider.get(mockRuntime, mockMessage, mockState);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    "x-chain": "ethereum",
                }),
            })
        );
    });

    test("defaults to solana chain when not specified", async () => {
        mockMessage.content.text =
            "what is the price of 0x1234567890123456789012345678901234567890";
        await priceProvider.get(mockRuntime, mockMessage, mockState);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    "x-chain": "solana",
                }),
            })
        );
    });

    test("recognizes various price keywords", async () => {
        const priceKeywords = [
            "price",
            "cost",
            "worth",
            "value",
            "rate",
            "quote",
            "how much",
        ];

        for (const keyword of priceKeywords) {
            mockMessage.content.text = `${keyword} of 0x1234567890123456789012345678901234567890`;
            const result = await priceProvider.get(
                mockRuntime,
                mockMessage,
                mockState
            );
            expect(result).not.toBeNull();
        }
    });

    test("handles different address formats", async () => {
        // Test Ethereum address
        mockMessage.content.text =
            "price of 0x1234567890123456789012345678901234567890";
        let result = await priceProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).not.toBeNull();

        // Test Solana address
        mockMessage.content.text =
            "price of TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        result = await priceProvider.get(mockRuntime, mockMessage, mockState);
        expect(result).not.toBeNull();
    });
});
