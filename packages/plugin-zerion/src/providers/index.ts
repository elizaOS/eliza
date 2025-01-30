import { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { ZERION_V1_BASE_URL } from "../constants.ts";
import { PortfolioData, PositionData, ZerionPortfolioResponse, ZerionPositionResponse, ZerionProviderResponse } from "../types.ts";

interface ZerionProvider extends Provider {
    getPositions(runtime: IAgentRuntime, message: Memory): Promise<ZerionProviderResponse>;
    get(runtime: IAgentRuntime, message: Memory, state?: State): Promise<ZerionProviderResponse>;
}

export const zerionProvider: ZerionProvider = {
    get: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<ZerionProviderResponse> => {
        try {
            if (!process.env.ZERION_API_KEY) {
                throw new Error("Zerion API key not found in environment variables. Make sure to set the ZERION_API_KEY environment variable.");
            }
            const content = message.content as { text: string };
            const addressMatch = content.text.match(/0x[a-fA-F0-9]{40}/);
            if (!addressMatch) {
                throw new Error("Valid ethereum address not found in message");
            }
            const address = addressMatch[0];
            const baseUrl = ZERION_V1_BASE_URL;

            const response = await fetch(`${baseUrl}/wallets/${address}/portfolio`, {
                method: "GET",
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Basic ${process.env.ZERION_API_KEY}`
                }
            });


            if (!response.ok) {
                throw new Error(`Failed to fetch portfolio: ${response.statusText}`);
            }

            const apiResponse: ZerionPortfolioResponse = await response.json();
            const { attributes } = apiResponse.data;

            const portfolioData: PortfolioData = {
                totalValue: attributes.total.positions,
                chainDistribution: attributes.positions_distribution_by_chain,
                positionTypes: attributes.positions_distribution_by_type,
                changes: {
                    absolute_1d: attributes.changes.absolute_1d,
                    percent_1d: attributes.changes.percent_1d
                }
            };

            return { success: true, data: portfolioData };

        } catch (error) {
            console.log("error fetching portfolio", error);
            return { success: false, error: error instanceof Error ? error.message : "Failed to fetch portfolio data from zerion" };
        }

    },

    getPositions: async (_runtime: IAgentRuntime, message: Memory): Promise<ZerionProviderResponse> => {
        const addressMatch = message.content.text.match(/0x[a-fA-F0-9]{40}/);
        if (!addressMatch) {
            return {
                success: false,
                error: "No valid address found in message"
            };
        }

        const address = addressMatch[0];
        const response = await fetch(`https://api.zerion.io/v1/wallets/${address}/positions?filter[positions]=only_simple&currency=usd&filter[trash]=only_non_trash&sort=value`, {
            headers: {
                "Accept": "application/json",
                "Authorization": `Basic ${process.env.ZERION_API_KEY}`
            }
        });
        const data = await response.json() as ZerionPositionResponse;

        let totalValue = 0;
        const positions = data.data.map(position => {
            const value = position.attributes.value || 0;
            totalValue += value;

            return {
                name: position.attributes.fungible_info.name,
                symbol: position.attributes.fungible_info.symbol,
                quantity: position.attributes.quantity.float,
                value: position.attributes.value,
                price: position.attributes.price,
                chain: position.relationships.chain.data.id,
                change24h: position.attributes.changes?.percent_1d || null,
                verified: position.attributes.fungible_info.flags.verified
            };
        });

        return {
            success: true,
            data: {
                positions,
                totalValue
            } as PositionData
        };
    }
}