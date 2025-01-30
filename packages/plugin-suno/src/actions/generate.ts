import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { SunoProvider } from "../providers/suno";
import type { GenerateParams } from "../types";

const generateMusic: Action = {
    name: "generate-music",
    description: "Generate music using Suno AI",
    similes: [
        "CREATE_MUSIC",
        "MAKE_MUSIC",
        "COMPOSE_MUSIC",
        "GENERATE_AUDIO",
        "CREATE_SONG",
        "MAKE_SONG"
    ],

    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        return !!runtime.getSetting("SUNO_API_KEY");
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const provider = await SunoProvider.get(runtime, message, state);
            const content = message.content as unknown as GenerateParams;

            if (!content.prompt) {
                throw new Error("Missing required parameter: prompt");
            }

            const response = await provider.request('/generate', {
                method: 'POST',
                body: JSON.stringify({
                    prompt: content.prompt,
                    duration: content.duration || 30,
                    temperature: content.temperature || 1.0,
                    top_k: content.topK || 250,
                    top_p: content.topP || 0.95,
                    classifier_free_guidance: content.classifier_free_guidance || 3.0
                })
            });

            if (callback) {
                callback({
                    text: 'Successfully generated music based on your prompt',
                    content: response
                });
            }

            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Failed to extend audio: ${(error as Error).message}`,
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
                    duration: 30,
                    temperature: 1.0
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll generate a happy and energetic song for you.",
                    action: "generate-music"
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
                    text: "Generate a relaxing ambient track",
                    prompt: "A peaceful ambient soundscape with gentle waves and soft pads",
                    duration: 45,
                    temperature: 0.8,
                    classifier_free_guidance: 4.0
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll create a calming ambient piece for you.",
                    action: "generate-music"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully generated your relaxing ambient soundscape."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Make a short jingle for my podcast",
                    prompt: "A catchy and professional podcast intro jingle",
                    duration: 15,
                    temperature: 1.2,
                    top_k: 300
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll generate a podcast jingle for you.",
                    action: "generate-music"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully generated your podcast jingle."
                }
            }
        ]
    ]
};

export default generateMusic;