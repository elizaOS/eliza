import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { SunoProvider } from "../providers/suno";
import type { CustomGenerateParams } from "../types";

const customGenerateMusic: Action = {
    name: "custom-generate-music",
    description: "Generate music with custom parameters using Suno AI",
    similes: [
        "CREATE_CUSTOM_MUSIC",
        "GENERATE_CUSTOM_AUDIO",
        "MAKE_CUSTOM_MUSIC",
        "COMPOSE_CUSTOM_MUSIC",
        "COMPOSE_MUSIC",
        "CREATE_MUSIC",
        "GENERATE_MUSIC"

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
            const content = message.content as unknown as CustomGenerateParams;

            if (!content.prompt) {
                throw new Error("Missing required parameter: prompt");
            }

            const response = await provider.request('/custom-generate', {
                method: 'POST',
                body: JSON.stringify({
                    prompt: content.prompt,
                    duration: content.duration || 30,
                    temperature: content.temperature || 1.0,
                    top_k: content.topK || 250,
                    top_p: content.topP || 0.95,
                    classifier_free_guidance: content.classifier_free_guidance || 3.0,
                    reference_audio: content.reference_audio,
                    style: content.style,
                    bpm: content.bpm,
                    key: content.key,
                    mode: content.mode
                })
            });

            if (callback) {
                callback({
                    text: 'Successfully generated custom music',
                    content: response
                });
            }

            return true;
        } catch (error) {
            if (callback) {
                callback({
                    text: `Failed to generate custom music: ${(error as Error).message}`,
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
                    text: "Create an upbeat electronic dance track with heavy bass",
                    prompt: "An upbeat electronic dance track with heavy bass and energetic synths",
                    duration: 60,
                    style: "electronic",
                    bpm: 128
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll generate an energetic EDM track for you.",
                    action: "custom-generate-music"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully generated your EDM track with heavy bass and synths."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate a calm piano melody in C major",
                    prompt: "A gentle, flowing piano melody with soft dynamics",
                    duration: 45,
                    style: "classical",
                    key: "C",
                    mode: "major",
                    temperature: 0.8
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll create a calming piano piece in C major for you.",
                    action: "custom-generate-music"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully generated your peaceful piano melody in C major."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Make a rock song with guitar solos",
                    prompt: "A rock song with powerful electric guitar solos and driving drums",
                    duration: 90,
                    style: "rock",
                    bpm: 120,
                    classifier_free_guidance: 4.0
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll generate a rock track with guitar solos for you.",
                    action: "custom-generate-music"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully generated your rock song with guitar solos."
                }
            }
        ]
    ]
};

export default customGenerateMusic;