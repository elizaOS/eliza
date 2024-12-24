import { IAgentRuntime, Memory, State } from "@elizaos/core";
import { tokenOverviewProvider } from "../token-overview-provider";

// Mock data
const mockTokenOverview = {
    address: "0x1234567890123456789012345678901234567890",
    symbol: "TEST",
    name: "Test Token",
    decimals: 18,
    logoURI: "https://example.com/logo.png",
    price: 1.23,
    priceChange24hPercent: 5.67,
    liquidity: 1000000,
    marketCap: 10000000,
    realMc: 9000000,
    supply: 1000000,
    circulatingSupply: 900000,
    holder: 1000,
    v24h: 100000,
    v24hUSD: 123000,
    lastTradeUnixTime: 1704067200,
    numberMarkets: 5,
    extensions: {
        website: "https://example.com",
        twitter: "https://twitter.com/test",
        telegram: "https://t.me/test",
        discord: "https://discord.gg/test",
        description: "A test token",
        coingeckoId: "test-token",
    },
};

// Mock fetch globally
global.fetch = jest.fn();

describe("Token Overview Provider", () => {
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
                text: "Show me overview of 0x1234567890123456789012345678901234567890 on ethereum",
            },
        } as Memory;

        // Mock state
        mockState = {} as State;

        // Mock successful fetch response
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({ data: mockTokenOverview }),
        });
    });

    test("returns null when API key is missing", async () => {
        (mockRuntime.getSetting as jest.Mock).mockReturnValue(null);
        const result = await tokenOverviewProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("returns null when message does not contain overview keywords", async () => {
        mockMessage.content.text = "random message without overview keywords";
        const result = await tokenOverviewProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("returns null when no contract address is found", async () => {
        mockMessage.content.text = "show overview of invalid-address";
        const result = await tokenOverviewProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("handles API error gracefully", async () => {
        (global.fetch as jest.Mock).mockRejectedValue(new Error("API Error"));
        const result = await tokenOverviewProvider.get(
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
        const result = await tokenOverviewProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).toBeNull();
    });

    test("formats token overview correctly", async () => {
        const result = await tokenOverviewProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );

        // Verify the result contains all expected sections
        expect(result).toContain("Token Overview for Test Token (TEST)");
        expect(result).toContain("📊 Market Data");
        expect(result).toContain("📈 Trading Info");
        expect(result).toContain("💰 Supply Information");
        expect(result).toContain("🔗 Token Details");
        expect(result).toContain("🌐 Social Links");

        // Verify specific data points
        expect(result).toContain(`Current Price: $${mockTokenOverview.price}`);
        expect(result).toContain(`Market Cap: $${mockTokenOverview.marketCap}`);
        expect(result).toContain(mockTokenOverview.address);
        expect(result).toContain(mockTokenOverview.extensions.website);
    });

    test("handles missing social links gracefully", async () => {
        const tokenWithoutSocials = {
            ...mockTokenOverview,
            extensions: undefined,
        };
        (global.fetch as jest.Mock).mockResolvedValue({
            ok: true,
            json: async () => ({ data: tokenWithoutSocials }),
        });

        const result = await tokenOverviewProvider.get(
            mockRuntime,
            mockMessage,
            mockState
        );
        expect(result).not.toContain("🌐 Social Links");
    });

    test("extracts chain correctly", async () => {
        mockMessage.content.text =
            "show overview of 0x1234567890123456789012345678901234567890 on ethereum";
        await tokenOverviewProvider.get(mockRuntime, mockMessage, mockState);

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
            "show overview of 0x1234567890123456789012345678901234567890";
        await tokenOverviewProvider.get(mockRuntime, mockMessage, mockState);

        expect(global.fetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    "x-chain": "solana",
                }),
            })
        );
    });
});
