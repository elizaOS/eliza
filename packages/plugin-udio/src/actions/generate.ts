import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { UdioProvider } from "../providers/udio";
import type { UdioGenerateOptions } from "../types";

const generateMusic: Action = {
    name: "generate",
    description: "Generate music using Udio AI",
    similes: [
        "CREATE_MUSIC",
        "MAKE_MUSIC",
        "COMPOSE_MUSIC",
        "GENERATE_AUDIO",
        "CREATE_SONG",
        "MAKE_SONG"
    ],

    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        return !!runtime.getSetting("UDIO_AUTH_TOKEN");
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const provider = await UdioProvider.get(runtime, message, state);
            const content = message.content as unknown as UdioGenerateOptions;

            if (!content.prompt) {
                throw new Error("Missing required parameter: prompt");
            }

            const generateResult = await provider.generateSong(
                content.prompt,
                { seed: content.seed || -1 },
                content.customLyrics
            );

            // Wait for processing to complete
            while (true) {
                const status = await provider.checkSongStatus(generateResult.track_ids);
                if (status.songs.every(song => song.finished)) {
                    if (callback) {
                        callback({
                            text: 'Successfully generated music based on your prompt',
                            content: status
                        });
                    }
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        } catch (error) {
            if (callback) {
                callback({
                    text: `Failed to generate music: ${(error as Error).message}`,
                    error: error
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
                    text: "Create a happy and energetic song",
                    prompt: "A cheerful and energetic melody with upbeat rhythm",
                    seed: 12345
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll generate a happy and energetic song for you.",
                    action: "generate"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully generated your upbeat and energetic song."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate a song with custom lyrics",
                    prompt: "A pop song with vocals",
                    seed: 54321,
                    customLyrics: "Verse 1: This is my custom song..."
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll create a pop song with your custom lyrics.",
                    action: "generate"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully generated your song with custom lyrics."
                }
            }
        ]
    ]
};

export default generateMusic;