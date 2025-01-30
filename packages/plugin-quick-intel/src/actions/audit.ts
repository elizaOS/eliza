import {
    Action,
    ActionExample,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    composeContext,
    elizaLogger,
    generateMessageResponse
} from "@elizaos/core";
import { auditTemplate } from "../templates";
import { extractTokenInfo } from "../utils/chain-detection";

interface AuditResponse {
    tokenDetails?: {
        tokenName: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface DexPair {
    chainId: string;
    [key: string]: unknown;
}

interface DexResponse {
    pairs?: DexPair[];
    otherChains?: string[];
}
class TokenAuditAction {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async audit(chain: string, tokenAddress: string): Promise<AuditResponse> {
        elizaLogger.log("Auditing token:", { chain, tokenAddress });
        const myHeaders = new Headers();
        myHeaders.append("X-QKNTL-KEY", this.apiKey);
        myHeaders.append("Content-Type", "application/json");

        const requestOptions: RequestInit = {
            method: "POST",
            headers: myHeaders,
            body: JSON.stringify({ chain, tokenAddress }),
            redirect: "follow" as RequestRedirect,
        };

        const response = await fetch("https://api.quickintel.io/v1/getquickiauditfull", requestOptions);
        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }
        return await response.json();
    }

    async fetchDexData(tokenAddress: string, chain: string): Promise<DexResponse | null> {
        elizaLogger.log("Fetching DEX data:", { tokenAddress, chain });
        const myHeaders = new Headers();
        myHeaders.append("Content-Type", "application/json");

        const requestOptions: RequestInit = {
            method: "GET",
            headers: myHeaders,
        };

        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, requestOptions);
        if (!response.ok) {
            throw new Error(`DexScreener API failed with status ${response.status}`);
        }

        const data = await response.json();
        if (!data?.pairs?.length) {
            return null;
        }

        // Filter pairs for the target chain
        const chainPairs = data.pairs.filter((pair: DexPair) =>
            pair.chainId.toLowerCase() === chain.toLowerCase() || pair.chainId.toLowerCase().includes(chain.toLowerCase())
        );

        const otherChains = data.pairs
            .filter((pair: DexPair) => pair.chainId.toLowerCase() !== chain.toLowerCase())
            .map((pair: DexPair) => pair.chainId) as string[];

        return {
            pairs: chainPairs,
            otherChains: [...new Set(otherChains)]
        };
    }
}

export const auditAction: Action = {
    name: "AUDIT_TOKEN",
    description: "Perform a security audit on a token using QuickIntel",
    similes: ["SCAN_TOKEN", "CHECK_TOKEN", "TOKEN_SECURITY", "ANALYZE_TOKEN"],
    validate: async (runtime: IAgentRuntime) => {
        const apiKey = runtime.getSetting("QUICKINTEL_API_KEY");
        return typeof apiKey === "string" && apiKey.length > 0;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting QuickIntel audit handler...");

        try {
            const apiKey = runtime.getSetting("QUICKINTEL_API_KEY");
            if (!apiKey) {
                throw new Error("QuickIntel API key not configured");
            }

            // Extract chain and address from the message content
            const messageText = message.content.text;
            const { chain, tokenAddress } = extractTokenInfo(messageText);

            if (!chain || !tokenAddress) {
                throw new Error("Could not determine chain and token address. Please specify both the chain and token address.");
            }

            // Perform audit
            elizaLogger.log("Performing audit for:", { chain, tokenAddress });
            const action = new TokenAuditAction(apiKey);
            const [auditData, dexData] = await Promise.all([
                action.audit(chain, tokenAddress),
                action.fetchDexData(tokenAddress, chain)
            ]);

            const newState = await runtime.composeState(message, {
                ...state,
                auditData: JSON.stringify(auditData, null, 2),
                marketData: auditData?.tokenDetails?.tokenName ? JSON.stringify(dexData, null, 2) : null,
            });


            // Generate analysis using audit data
            const context = composeContext({
                state: newState,
                template: auditTemplate
            });

            const responseContent = await generateMessageResponse({
                runtime,
                context,
                modelClass: ModelClass.LARGE
            });

            if (!responseContent) {
                throw new Error("Failed to generate audit analysis");
            }

            //await callback(response);
            if (callback) {
                const response = {
                    text: responseContent.text,
                    content: {
                        success: true,
                        data: auditData,
                        params: { chain, tokenAddress }
                    },
                    action: responseContent.action,
                    inReplyTo: message.id
                };

                const memories = await callback(response);
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in AUDIT_TOKEN handler:", error?.message, error?.error);

            if (callback) {
                await callback({
                    text: "An error occurred while performing the token audit. Please try again later, and ensure the address is correct, and chain is supported.",
                    content: { error: "Internal server error" },
                    inReplyTo: message.id
                });
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you check if this token is safe? 0x742d35Cc6634C0532925a3b844Bc454e4438f44e on BSC",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll analyze this token's security for you.",
                    action: "AUDIT_TOKEN",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Here's what I found in the security audit:\n\n🔒 Overall Security Status: Medium Risk\n\nKey Findings:\n✅ Contract is verified\n✅ Not a honeypot\n⚠️ Ownership not renounced\n\nDetailed Analysis:\n...",
                },
            },
        ],
    ] as ActionExample[][],
};