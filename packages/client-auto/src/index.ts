import {
    Client,
    IAgentRuntime,
    composeContext,
    generateText,
    Memory,
    stringToUuid,
    Content,
    getRelevantContext,
    ModelClass,
    elizaLogger,
    UUID,
} from "@ai16z/eliza";
import {
    TrustScoreManager,
    TokenProvider,
    WalletProvider,
} from "@ai16z/plugin-solana";
import { TrustScoreDatabase } from "@ai16z/plugin-trustdb";
import { formatThesisTemplate } from "./templates.ts";
import { Connection, PublicKey } from "@solana/web3.js";
import { v4 as uuidv4 } from "uuid";
export class AutoClient {
    interval: NodeJS.Timeout;
    runtime: IAgentRuntime;
    trustScoreProvider: InstanceType<typeof TrustScoreManager>;
    walletProvider: InstanceType<typeof WalletProvider>;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;

        // Ensure the database adapter is properly initialized before creating TrustScoreDatabase
        if (!runtime.trustScoreDb?.db) {
            throw new Error("Database adapter is not properly initialized");
        }

        const trustScoreDb = new TrustScoreDatabase(
            runtime.trustScoreDb.db
        );
        this.trustScoreProvider = new TrustScoreManager(
            runtime,
            null,
            trustScoreDb
        );
        this.walletProvider = new WalletProvider(
            new Connection(runtime.getSetting("RPC_URL")),
            new PublicKey(runtime.getSetting("WALLET_PUBLIC_KEY"))
        );

        // start a loop that runs every x seconds
        this.makeTrades();
        this.interval = setInterval(
            async () => {
                await this.makeTrades();
            },
            60 * 60 * 1000
        ); // 1 hour in milliseconds
    }

    async makeTrades() {
        console.log("Running auto loop");

        // malibu todos
        const startDate = new Date(new Date().getTime() - 60 * 60 * 1000);
        const endDate = new Date();
        // get recommendations from the last hour (or whatever time period we want) in order desc by trust score
        const recommendations =
            await this.trustScoreProvider.getRecommendations(
                startDate,
                endDate
            );
        // get high trust recommendations
        const highTrustRecommendations = recommendations.filter(
            (r) => r.averageTrustScore > 0.7
        );

        // get information for all tokens which were recommended
        const tokenInfoResults = await Promise.all(
            highTrustRecommendations.map(async (highTrustRecommendation) => {
                const tokenProvider = new TokenProvider(
                    highTrustRecommendation.tokenAddress,
                    this.walletProvider,
                    this.runtime.cacheManager
                );
                const tokenInfo = await tokenProvider.getProcessedTokenData();
                const shouldTrade = await tokenProvider.shouldTradeToken();
                return { tokenInfo, shouldTrade };
            })
        );
        if (tokenInfoResults.length === 0) {
            elizaLogger.info("No tradable tokens found");
            return;
        }
        // Create content
        const content: Content = {
            text: `Tradeable token data:\n${JSON.stringify(tokenInfoResults, null, 2)}`,
            source: "auto",
        };

        const roomId = stringToUuid(
            uuidv4() + "-" + this.runtime.agentId
        ) as UUID;

        // Ensure room exists
        await this.runtime.ensureConnection(
            this.runtime.agentId, // userId
            roomId,
        );

        // create memory for the tradable tokens
        const memory: Memory = {
            id: stringToUuid(uuidv4()),
            agentId: this.runtime.agentId,
            userId: this.runtime.agentId,
            roomId: roomId,
            content: content,
            createdAt: new Date().getTime(),
        };

        // Create memory
        await this.runtime.messageManager.addEmbeddingToMemory(memory);
        await this.runtime.messageManager.createMemory(memory);
        const relevantMemories = await getRelevantContext(
            this.runtime,
            content.text,
            "memories"
        );

        const formattedMemories = relevantMemories.map((memory) => ({
            content: memory.content,
            createdAt: memory.createdAt,
            userId: memory.userId,
            similarity: memory.similarity,
        }));

        // format tradable tokens
        const formattedTradableTokens = tokenInfoResults.map((token) => ({
            security: token.tokenInfo.security,
            tradeData: token.tokenInfo.tradeData,
            holderDistributionTrend: token.tokenInfo.holderDistributionTrend,
            highValueHolders: token.tokenInfo.highValueHolders,
            recentTrades: token.tokenInfo.recentTrades,
            highSupplyHoldersCount: token.tokenInfo.highSupplyHoldersCount,
            dexScreenerData: token.tokenInfo.dexScreenerData,
            isDexScreenerListed: token.tokenInfo.isDexScreenerListed,
            isDexScreenerPaid: token.tokenInfo.isDexScreenerPaid,
        }));
        elizaLogger.info(
            "formattedTradableTokens: " +
                JSON.stringify(formattedTradableTokens, null, 2)
        );
        // shaw -- TODOs
        const state = await this.runtime.composeState(memory, {
            relevantMemories: formattedMemories,
            tradableTokens: formattedTradableTokens,
        });
        elizaLogger.info("state: " + JSON.stringify(state, null, 2));
        // compose thesis context
        const thesisContext = composeContext({
            state,
            template: formatThesisTemplate,
        });
        elizaLogger.info("thesisContext: " + JSON.stringify(thesisContext, null, 2));
        // write a thesis which trades and why
        const thesis = await generateText({
            runtime: this.runtime,
            context: thesisContext,
            modelClass: ModelClass.LARGE,
        });
        elizaLogger.info("Thesis: " + thesis);
        // compose trade context
        // geratate trades with LLM
        // parse trades from LLM
        // post thesis to twitter

        // malibu todos
        // execute trades
    }
}

export const AutoClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        const client = new AutoClient(runtime);
        return client;
    },
    stop: async (runtime: IAgentRuntime) => {
        console.warn("Direct client does not support stopping yet");
    },
};

export default AutoClientInterface;
