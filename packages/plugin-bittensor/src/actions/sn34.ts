import {
    ActionExample,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    type Action,
} from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";

interface AIImageDetectionResult {
    isAIGenerated: boolean;
    confidenceScore: number;
}

interface AIImageAnalysisMemory extends Memory {
    content: {
        text: string;
        imageUrl: string;
        isAIGenerated: boolean;
        confidenceScore: number;
        imageSource: 'tweet' | 'url';
        actionType: string;
    };
}

export const formatAnalysisHistory = (analyses: AIImageAnalysisMemory[]) => {
    const analysisStrings = analyses
        .reverse()
        .map((analysis: AIImageAnalysisMemory) => {
            const { isAIGenerated, confidenceScore } = analysis.content;
            const scorePercentage = Number(confidenceScore);
            return `Image Analysis: ${isAIGenerated ? 'AI Generated' : 'Natural'} (${(scorePercentage * 100).toFixed(2)}% confidence)`;
        });
    return analysisStrings.join("\n");
};

const validateAnalysisRequest = async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    elizaLogger.info("🔍 BitMind: Validating analysis request...");
    
    const urlMatch = message?.content?.text?.match(/https?:\/\/[^\s]+/);
    const imageUrls = message?.content?.imageUrls as string[] | undefined;

    if (!urlMatch && (!imageUrls || imageUrls.length === 0)) {
        elizaLogger.error("❌ BitMind: No image URL found in request");
        return false;
    }

    if (!runtime?.character?.settings?.secrets?.BITMIND) {
        elizaLogger.error("❌ BitMind: API credentials not configured");
        return false;
    }

    elizaLogger.info("✅ BitMind: Request validation successful");
    return true;
};

const extractImageUrl = (message: Memory): { url: string; isTweet: boolean } => {
    const urlMatch = message.content.text.match(/https?:\/\/[^\s]+/);
    const imageUrls = message.content.imageUrls as string[] | undefined;
    const isTweet = Boolean(imageUrls && imageUrls.length > 0);

    if (isTweet && imageUrls) {
        return { url: imageUrls[0], isTweet };
    } 
    if (urlMatch) {
        return { url: urlMatch[0], isTweet };
    }
    throw new Error("No valid image URL found in request");
};

const analyzeImageWithBitMind = async (imageUrl: string, apiKey: string): Promise<AIImageDetectionResult> => {
    try {
        const response = await fetch("https://subnet-api.bitmindlabs.ai/detect-image", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ image: imageUrl })
        });

        if (!response.ok) {
            const errorMessage = `BitMind API error (${response.status}): ${response.statusText}`;
            elizaLogger.error(`❌ ${errorMessage}`);
            if (response.status === 500) {
                throw new Error("BitMind service is currently experiencing issues. Please try again later.");
            }
            throw new Error(errorMessage);
        }

        const result = await response.json();
        return {
            isAIGenerated: result.isAI,
            confidenceScore: result.confidence
        };
    } catch (error) {
        if (error.message.includes('BitMind service')) {
            throw error; // Re-throw our custom error
        }
        elizaLogger.error('❌ BitMind API request failed:', error);
        throw new Error('Failed to connect to BitMind service. Please check your connection and try again.');
    }
};

const generateAnalysisReport = (result: AIImageDetectionResult): string => {
    const confidencePercent = (result.confidenceScore * 100).toFixed(2);
    const confidenceValue = parseFloat(confidencePercent);
    
    return `🔍 Trinity Matrix Deepfake Analysis
Powered by BitMind Subnet (SN34) on Bittensor

${result.isAIGenerated ? '🤖 AI Generated' : '📸 Natural Image'}
${confidencePercent}% AI Influence Rating
${confidenceValue > 75 
    ? "⚠️ High synthetic probability detected. Approach with caution." 
    : confidenceValue > 40 
        ? "⚡ Moderate AI patterns present. Verification recommended." 
        : "✅ Low synthetic markers. Likely authentic content."}

—————————————————`;
};

export const analyzeImage: Action = {
    name: "DETECT_IMAGE",
    similes: ["ANALYZE_IMAGE", "VERIFY_IMAGE", "BITMIND_DETECTION", "AI_DETECTION", "REAL_OR_FAKE"],
    validate: validateAnalysisRequest,
    description: "Analyze an image to determine if it was AI-generated using BitMind API",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<void> => {
        if (state['isAnalysisInProgress']) return;
        state['isAnalysisInProgress'] = true;

        elizaLogger.info("🤖 BitMind: Initiating image analysis...");
        
        if (!runtime.character?.settings?.secrets?.BITMIND) {
            throw new Error("BitMind API credentials not configured");
        }

        try {
            const { url: imageUrl, isTweet } = extractImageUrl(message);
            elizaLogger.info(`📸 BitMind: Processing image: ${imageUrl}`);

            const result = await analyzeImageWithBitMind(imageUrl, runtime.character.settings.secrets.BITMIND);

            elizaLogger.info(`✅ BitMind: Analysis complete`, {
                isAIGenerated: result.isAIGenerated,
                confidenceScore: result.confidenceScore,
                source: isTweet ? 'tweet' : 'message'
            });

            const analysisMemory: AIImageAnalysisMemory = {
                ...message,
                content: {
                    text: `Image Analysis: ${result.isAIGenerated ? 'AI Generated' : 'Natural'} (${(result.confidenceScore * 100).toFixed(2)}% confidence)`,
                    imageUrl: imageUrl,
                    isAIGenerated: result.isAIGenerated,
                    confidenceScore: result.confidenceScore,
                    imageSource: isTweet ? 'tweet' : 'url',
                    actionType: "DETECT_IMAGE"
                },
                createdAt: Date.now(),
            };

            elizaLogger.info("Saving analysis memory:", {
                roomId: message.roomId,
                analysisMemory
            });

            await runtime.messageManager.createMemory(analysisMemory);
            
            elizaLogger.info("Analysis memory saved");

            callback({
                text: generateAnalysisReport(result),
                isAIGenerated: result.isAIGenerated,
                confidenceScore: result.confidenceScore
            });

        } catch (error) {
            elizaLogger.error(`❌ BitMind: Analysis error:`, error);
            throw new Error(`Image analysis failed: ${error.message}`);
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "analyze this image: https://example.com/image.jpg" }
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll analyze that image for you...",
                    action: "DETECT_IMAGE"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "is this image AI generated?" }
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Let me check if that image is AI generated...",
                    action: "DETECT_IMAGE"
                }
            }
        ]
    ] as ActionExample[][],
} as Action;

const generateConfidenceBar = (confidence: number): string => {
    const barLength = 20;
    const filledBars = Math.round(confidence * barLength);
    const emptyBars = barLength - filledBars;
    return `[${'█'.repeat(filledBars)}${'░'.repeat(emptyBars)}]`;
};

export const analysisHistory: Action = {
    name: "IMAGE_REPORT",
    similes: ["SHOW_DETECTIONS", "IMAGE_HISTORY", "PAST_ANALYSES", "DETECTION_HISTORY"],
    validate: async (runtime: IAgentRuntime): Promise<boolean> => {
        return true;
    },
    description: "Display history of AI image analysis results",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<void> => {
        elizaLogger.info("📊 BitMind: Generating analysis history...");
        try {
            const limit = options?.limit || 10;
        
            // Get all rooms the agent is in
            const rooms = await runtime.databaseAdapter.getRoomsForParticipant(runtime.agentId);
            elizaLogger.info(`📊 BitMind: Found ${rooms.length} rooms`);
    
            // Get memories from each room and combine them
            const allMemories = await runtime.messageManager.getMemoriesByRoomIds({
                roomIds: rooms,
                limit: limit * 5
            }) as AIImageAnalysisMemory[];
    
            elizaLogger.info(`📊 BitMind: Retrieved ${allMemories.length} memories`);
    
            const imageAnalyses = allMemories.filter(
                mem => mem.content.actionType === 'DETECT_IMAGE'
            );

            elizaLogger.info(`📊 BitMind: Found ${imageAnalyses.length} image analyses`);

            if (!imageAnalyses || imageAnalyses.length === 0) {
                callback({
                    text: "No image analyses found.",
                });
                return;
            }
            const statistics = imageAnalyses.reduce((acc, analysis) => {
                acc.total++;
                if (analysis.content.isAIGenerated) acc.aiCount++;
                acc.avgConfidence += analysis.content.confidenceScore;
                return acc;
            }, { total: 0, aiCount: 0, avgConfidence: 0 });

            const reportText = `🔍 Trinity Matrix Analysis Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 Recent Analyses (${imageAnalyses.length})
${formatAnalysisHistory(imageAnalyses)}

📈 Statistical Overview
┌─────────────────────────────────┐
│ 🔍 Total Analyzed : ${statistics.total.toString().padEnd(12)} │
│ 🤖 AI Generated  : ${statistics.aiCount.toString().padEnd(12)} │
│ 📸 Natural       : ${(statistics.total - statistics.aiCount).toString().padEnd(12)} │
│ ⚡ AI Detection Rate: ${((statistics.aiCount / statistics.total) * 100).toFixed(1)}%      │
└─────────────────────────────────┘

🎯 Confidence Metrics
Average Confidence: ${((statistics.avgConfidence / statistics.total) * 100).toFixed(1)}%
${generateConfidenceBar(statistics.avgConfidence / statistics.total)}

Powered by BitMind Subnet (SN34) on Bittensor`;

            callback({ text: reportText });

        } catch (error) {
            elizaLogger.error(`❌ BitMind: History generation error:`, error);
            throw new Error(`Failed to generate analysis history: ${error.message}`);
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "show me recent image analyses" }
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's your image analysis report...",
                    action: "IMAGE_REPORT"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "what images have you checked recently?" }
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Let me show you the recent image detection history...",
                    action: "IMAGE_REPORT"
                }
            }
        ]
    ] as ActionExample[][],
} as Action;