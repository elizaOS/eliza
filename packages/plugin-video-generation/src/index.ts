import { elizaLogger } from "@elizaos/core";
import type {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@elizaos/core";
import fs from "node:fs"; 
import { LUMA_CONSTANTS } from "./constants";

const generateVideo = async (prompt: string, runtime: IAgentRuntime) => {
    const API_KEY = runtime.getSetting(LUMA_CONSTANTS.API_KEY_SETTING);

    try {
        elizaLogger.log("Starting video generation with prompt:", prompt);

        const response = await fetch(LUMA_CONSTANTS.API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            elizaLogger.error("Luma API error:", {
                status: response.status,
                statusText: response.statusText,
                error: errorText,
            });
            throw new Error(
                `Luma API error: ${response.statusText} - ${errorText}`
            );
        }

        const data = await response.json();
        elizaLogger.log(
            "Generation request successful, received response:",
            data
        );

        // Poll for completion
        let status = data.status;
        let videoUrl = null;
        const generationId = data.id;

        while (status !== "completed" && status !== "failed") {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds

            const statusResponse = await fetch(
                `${LUMA_CONSTANTS.API_URL}/${generationId}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${API_KEY}`,
                        accept: "application/json",
                    },
                }
            );

            if (!statusResponse.ok) {
                const errorText = await statusResponse.text();
                elizaLogger.error("Status check error:", {
                    status: statusResponse.status,
                    statusText: statusResponse.statusText,
                    error: errorText,
                });
                throw new Error(
                    `Failed to check generation status: ${errorText}`
                );
            }

            const statusData = await statusResponse.json();
            elizaLogger.log("Status check response:", statusData);

            status = statusData.state;
            if (status === "completed") {
                videoUrl = statusData.assets?.video;
            }
        }

        if (status === "failed") {
            throw new Error("Video generation failed");
        }

        if (!videoUrl) {
            throw new Error("No video URL in completed response");
        }

        return {
            success: true,
            data: videoUrl,
        };
    } catch (error) {
        elizaLogger.error("Video generation error:", error);
        return {
            success: false,
            error: error.message || "Unknown error occurred",
        };
    }
};

const videoGeneration: Action = {
    name: "GENERATE_VIDEO",
    similes: [
        "VIDEO_GENERATION",
        "VIDEO_GEN",
        "CREATE_VIDEO",
        "MAKE_VIDEO",
        "RENDER_VIDEO",
        "ANIMATE",
        "CREATE_ANIMATION",
        "VIDEO_CREATE",
        "VIDEO_MAKE",
    ],
    description: "Generate a video based on a text prompt",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("Validating video generation action");
        const lumaApiKey = runtime.getSetting("LUMA_API_KEY");
        elizaLogger.log("LUMA_API_KEY present:", !!lumaApiKey);
        return !!lumaApiKey;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: Record<string, unknown>,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Video generation request:", message);

        // Clean up the prompt by removing mentions and commands
        const videoPrompt = message.content.text
            .replace(/<@\d+>/g, "") // Remove mentions
            .replace(
                /generate video|create video|make video|render video/gi,
                ""
            ) // Remove commands
            .trim();

        if (!videoPrompt || videoPrompt.length < 5) {
            callback({
                text: "Could you please provide more details about what kind of video you'd like me to generate? For example: 'Generate a video of a sunset on a beach' or 'Create a video of a futuristic city'",
            });
            return;
        }

        elizaLogger.log("Video prompt:", videoPrompt);

        callback({
            text: `I'll generate a video based on your prompt: "${videoPrompt}". This might take a few minutes...`,
        });

        try {
            const result = await generateVideo(videoPrompt, runtime);

            if (result.success && result.data) {
                // Download the video file
                const response = await fetch(result.data);
                const arrayBuffer = await response.arrayBuffer();
                const videoFileName = `content_cache/generated_video_${Date.now()}.mp4`;

                // Save video file
                fs.writeFileSync(videoFileName, Buffer.from(arrayBuffer));

                callback(
                    {
                        text: "Here's your generated video!",
                        attachments: [
                            {
                                id: crypto.randomUUID(),
                                url: result.data,
                                title: "Generated Video",
                                source: "videoGeneration",
                                description: videoPrompt,
                                text: videoPrompt,
                            },
                        ],
                    },
                    [videoFileName]
                ); // Add the video file to the attachments
            } else {
                callback({
                    text: `Video generation failed: ${result.error}`,
                    error: true,
                });
            }
        } catch (error) {
            elizaLogger.error(`Failed to generate video. Error: ${error}`);
            callback({
                text: `Video generation failed: ${error.message}`,
                error: true,
            });
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Generate a video of a cat playing piano" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll create a video of a cat playing piano for you",
                    action: "GENERATE_VIDEO",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you make a video of a sunset at the beach?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I'll generate a beautiful beach sunset video for you",
                    action: "GENERATE_VIDEO",
                },
            },
        ],
    ],
} as Action;

export const videoGenerationPlugin: Plugin = {
    name: "videoGeneration",
    description: "Generate videos using Luma AI",
    actions: [videoGeneration],
    evaluators: [],
    providers: [],
};
