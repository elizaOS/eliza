import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { SunoProvider } from "../providers/suno";
import type { ExtendParams } from "../types";

const extendAudio: Action = {
    name: "extend-audio",
    description: "Extend the duration of an existing audio generation",
    similes: [
        "LENGTHEN_AUDIO",
        "PROLONG_AUDIO",
        "INCREASE_DURATION",
        "MAKE_AUDIO_LONGER"
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
            const content = message.content as unknown as ExtendParams;

            if (!content.audio_id || !content.duration) {
                throw new Error("Missing required parameters: audio_id and duration");
            }

            const response = await provider.request('/extend', {
                method: 'POST',
                body: JSON.stringify({
                    audio_id: content.audio_id,
                    duration: content.duration
                })
            });

            if (callback) {
                callback({
                    text: `Successfully extended audio ${content.audio_id}`,
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
                    text: "Make this song longer by 30 seconds",
                    audio_id: "abc123",
                    duration: 30
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll extend your song by 30 seconds.",
                    action: "extend-audio"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully extended your song by 30 seconds."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Double the length of this track",
                    audio_id: "xyz789",
                    duration: 60
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll double the duration of your track.",
                    action: "extend-audio"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully doubled the length of your track to 60 seconds."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Add 15 more seconds to this melody",
                    audio_id: "def456",
                    duration: 15
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll add 15 seconds to your melody.",
                    action: "extend-audio"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully added 15 seconds to your melody."
                }
            }
        ]
    ]
};

export default extendAudio;