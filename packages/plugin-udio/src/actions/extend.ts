import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { UdioProvider } from "../providers/udio";
import type { UdioExtendOptions } from "../types";

const extendMusic: Action = {
    name: "extend",
    description: "Extend an existing music piece using Udio AI",
    similes: [
        "CONTINUE_MUSIC",
        "EXTEND_SONG",
        "LENGTHEN_MUSIC",
        "CONTINUE_SONG",
        "EXTEND_AUDIO",
        "CONTINUE_AUDIO"
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
            const content = message.content as unknown as UdioExtendOptions;

            if (!content.prompt || !content.audioConditioningPath || !content.audioConditioningSongId) {
                throw new Error("Missing required parameters: prompt, audioConditioningPath, or audioConditioningSongId");
            }

            const generateResult = await provider.generateSong(
                content.prompt,
                {
                    seed: content.seed || -1,
                    audio_conditioning_path: content.audioConditioningPath,
                    audio_conditioning_song_id: content.audioConditioningSongId,
                    audio_conditioning_type: "continuation",
                    ...(content.cropStartTime !== undefined && { crop_start_time: content.cropStartTime })
                },
                content.customLyrics
            );

            // Wait for processing to complete
            while (true) {
                const status = await provider.checkSongStatus(generateResult.track_ids);
                if (status.songs.every(song => song.finished)) {
                    if (callback) {
                        callback({
                            text: 'Successfully extended the music based on your prompt',
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
                    text: `Failed to extend music: ${(error as Error).message}`,
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
                    text: "Extend this song with a similar style",
                    prompt: "Continue with the same energy and mood",
                    audioConditioningPath: "/path/to/original.mp3",
                    audioConditioningSongId: "original-123",
                    cropStartTime: 60
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll extend your song maintaining its style.",
                    action: "extend"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully extended your song."
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Continue this track with custom lyrics",
                    prompt: "Continue the melody and add vocals",
                    audioConditioningPath: "/path/to/song.mp3",
                    audioConditioningSongId: "song-456",
                    seed: 54321,
                    customLyrics: "Verse 2: Continuing the story..."
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll extend your track with the new lyrics.",
                    action: "extend"
                }
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully extended your track with the new lyrics."
                }
            }
        ]
    ]
};

export default extendMusic;