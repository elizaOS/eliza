import type { Provider, IAgentRuntime, Memory } from "@elizaos/core";
import type { ReservoirService } from "../services/reservoir";
import type { MarketIntelligenceService } from "../services/market-intelligence";
import type { SocialAnalyticsService } from "../services/social-analytics";

interface MarketIntelligenceResponse {
    washTradingMetrics: {
        washTradingScore: number;
        suspiciousVolume24h: number;
    };
    liquidityMetrics: {
        bestBid: number;
        bestAsk: number;
    };
    floorPrice?: number;
    volume24h?: number;
    marketCap?: number;
    holders?: number;
}

interface SocialMetricsResponse {
    twitterMetrics: {
        followers: number;
        engagement: {
            likes: number;
            retweets: number;
            replies: number;
        };
        trending: boolean;
    };
    communityMetrics: {
        totalMembers: number;
        growthRate: number;
        engagement: {
            activeUsers: number;
            messagesPerDay: number;
        };
    };
}

export const createNftCollectionProvider = (
    nftService: ReservoirService,
    marketIntelligenceService: MarketIntelligenceService,
    socialAnalyticsService: SocialAnalyticsService
): Provider => {
    return {
        get: async (
            runtime: IAgentRuntime,
            message: Memory
        ): Promise<string> => {
            if (!nftService) {
                throw new Error("NFT service not found");
            }

            const collections = await nftService.getTopCollections(runtime, 10);
            let response = "Here are the top NFT collections:\n\n";

            for (const collection of collections) {
                response += `${collection.name}:\n`;
                response += `• Floor Price: ${collection.floorPrice} ETH\n`;
                response += `• 24h Volume: ${collection.volume24h} ETH\n`;
                response += `• Market Cap: ${collection.marketCap} ETH\n`;
                response += `• Holders: ${collection.holders}\n\n`;
            }

            // If a specific collection is mentioned in the message, get detailed information
            const collection = collections.find(
                (c) =>
                    message.content.text
                        .toLowerCase()
                        .includes(c.name.toLowerCase()) ||
                    message.content.text
                        .toLowerCase()
                        .includes(c.address.toLowerCase())
            );

            if (collection) {
                response += `\nDetailed information for ${collection.name}:\n\n`;

                if (marketIntelligenceService) {
                    try {
                        const marketIntelligence = await marketIntelligenceService.getMarketIntelligence(
                            collection.address
                        ) as MarketIntelligenceResponse;
                        
                        response += "Market Intelligence:\n";
                        response += `• Wash Trading Score: ${marketIntelligence.washTradingMetrics.washTradingScore}\n`;
                        response += `• Suspicious Volume (24h): ${marketIntelligence.washTradingMetrics.suspiciousVolume24h} ETH\n`;
                        response += `• Best Bid: ${marketIntelligence.liquidityMetrics.bestBid} ETH\n`;
                        response += `• Best Ask: ${marketIntelligence.liquidityMetrics.bestAsk} ETH\n\n`;
                    } catch (error) {
                        console.error("Failed to fetch market intelligence:", error);
                    }
                }

                if (socialAnalyticsService) {
                    try {
                        const [socialMetrics, communityMetrics] = await Promise.all([
                            socialAnalyticsService.getSocialMetrics(collection.address),
                            socialAnalyticsService.getCommunityMetrics(collection.address)
                        ]) as [SocialMetricsResponse, SocialMetricsResponse];

                        response += "Social Metrics:\n";
                        response += `• Twitter Followers: ${socialMetrics.twitterMetrics.followers}\n`;
                        response += `• Twitter Engagement: ${
                            socialMetrics.twitterMetrics.engagement.likes + 
                            socialMetrics.twitterMetrics.engagement.retweets + 
                            socialMetrics.twitterMetrics.engagement.replies
                        } interactions\n`;
                        response += `• Trending: ${socialMetrics.twitterMetrics.trending ? "Yes" : "No"}\n\n`;

                        response += "Community Metrics:\n";
                        response += `• Total Members: ${communityMetrics.communityMetrics.totalMembers}\n`;
                        response += `• Growth Rate: ${communityMetrics.communityMetrics.growthRate}%\n`;
                        response += `• Active Users: ${communityMetrics.communityMetrics.engagement.activeUsers}\n`;
                        response += `• Messages per Day: ${communityMetrics.communityMetrics.engagement.messagesPerDay}\n`;
                    } catch (error) {
                        console.error("Failed to fetch social analytics:", error);
                    }
                }
            }

            return response;
        },
    };
};
