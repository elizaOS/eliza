import { elizaLogger, type HandlerCallback, type IAgentRuntime, type Plugin, type State } from "@elizaos/core";
import type { Memory } from "@elizaos/core";


/*
const improvePrompt = false;

//None of this really works with the default generateText() function, so I'm leaving it out for now.
let IMAGE_SYSTEM_PROMPT;

if(improvePrompt){
    IMAGE_SYSTEM_PROMPT = `You are an expert in writing prompts for AI art generation for T5 based models. You excel at creating detailed and creative visual descriptions. Incorporating specific elements naturally. Always aim for clear, descriptive language that generates a creative picture. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that...`;
}
else
{
    IMAGE_SYSTEM_PROMPT = `You are an expert in writing Text-to-Image prompts. Your task is to analyze a user's instruction and extract only his demand for an image. You should be able to understand the user's request and generate a prompt that is clear and concise. Your output should only contain the description of the image contents, but NOT an instruction like "create an image that... You never REMOVE any information from the user's request, except for his instructions like "Make an image of...". You DO NEVER REMOVE any tags like for example @hailee or @modelname and you DO NOT REMOVE intensities like :0.3, as in @hailee:0.3. You DO NEVER REMOVE any information that is not an instruction.`;
}
*/

async function pollLetzAiImageStatus(
    id: string,
    letzAiApiKey: string,
    callback: (response: { text: string; attachments?: Array<{ id: string; url: string; title: string; source: string; description: string; contentType: string; text: string; }> }) => void,
    maxPolls = 40,
    pollIntervalMs = 3000 // 3 seconds
) {
    let polls = 0;
    let isReady = false;

    while (!isReady && polls < maxPolls) {
        // Wait 3 seconds before checking
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        polls++;

       callback({
            text: `Still working on your image... (Poll #${polls})`,
        });

        try {
            const resp = await fetch(`https://api.letz.ai/images/${id}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${letzAiApiKey}`,
                },
            });
            if (!resp.ok) {
                callback({
                    text: `Error checking LetzAI status: ${resp.status} - ${resp.statusText}`,
                });
                return;
            }

            const statusData = await resp.json();
            const { status, imageVersions } = statusData;

            if (status === "ready") {
                isReady = true;
                // The final image URL might be in imageVersions["original"]
                let finalUrl = imageVersions?.original;
                if (Array.isArray(finalUrl) && finalUrl.length > 0) {
                    finalUrl = finalUrl[0];
                }

                if (!finalUrl) {
                    callback({
                        text: 'Image is ready, but no final URL found.',
                    });
                    return;
                }

                callback({
                    text: 'Your image is ready!',
                    attachments: [
                        {
                            id,
                            url: finalUrl,
                            title: "LetzAI Full Image",
                            source: "letzAiImageGeneration",
                            description: "Full-size image from LetzAI",
                            contentType: "image/jpeg",
                            text: "Here's your final image (original).",
                        },
                    ],
                });
            }
        } catch (err: unknown) {
            callback({
                text: `Error while polling LetzAI: ${err instanceof Error ? err.message : "Unknown error"}`,
            });
            return;
        }
    }

    if (!isReady) {
        callback({
            text: `The image is still not ready after ${maxPolls} polls. Please try again later.`,
        });
    }
}

export const letzAiImageGeneration = {
    name: "GENERATE_IMAGE",
    similes: ["IMAGE_GENERATION", "IMAGE_GEN"],
    description: "Generate an image via LetzAI API (with polling).",
    suppressInitialMessage: true,

    validate: async (_runtime: IAgentRuntime, _message: Memory, _state: State) => {
        // Provide a default validate() that simply returns true
        return true;
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        options: {
            width?: number;
            height?: number;
            quality?: number;
            creativity?: number;
            seed?: number;
            modelId?: string;
            jobId?: string;
            hasWatermark?: boolean;
            mode?: "default" | "sigma";
            systemVersion?: number;
        },
        callback: HandlerCallback
    ) => {
        try {
            // 1) Get the LLM's response
            elizaLogger.log("Composing state for message:", message.content.text);

            // Removed logging of non-existent property recentMessagesData
            callback({
                text: message.content.text,

            });

            // 2) Next, send the prompt to LetzAI
            const userPrompt = message?.content?.text || "No prompt provided.";
            const letzAiApiKey = runtime.getSetting("LETZAI_API_KEY") || "fake_api_key";
            const letzAiModels = runtime.getSetting("LETZAI_MODELS") || "";

            const width = options.width ?? 720;
            const height = options.height ?? 1280;
            const quality = options.quality ?? 2;
            const creativity = options.creativity ?? 1;
            const hasWatermark = options.hasWatermark ?? true;
            const systemVersion = options.systemVersion ?? 3;
            const mode = options.mode?? "default";

            //use this if you want to improve your prompts some more before submitting them
            //we're not using it rn, because the generateText() function doesn't seem to work properly and returns bad prompts
            /*
            const CONTENT = `${userPrompt}`.trim();

            const IMAGE_PROMPT_INPUT = `${CONTENT}`;

            let imagePrompt = await generateText({
                runtime,
                context: IMAGE_PROMPT_INPUT,
                modelClass: ModelClass.LARGE,
                customSystemPrompt: IMAGE_SYSTEM_PROMPT,
            });*/

            let imagePrompt = userPrompt.trim();

            //Prepend our Models from the .env config to make sure characters, styles and objects are respected
            imagePrompt = `${letzAiModels}, ${imagePrompt}`;
            const prompt = imagePrompt;

            elizaLogger.log("Image prompt received:", imagePrompt);

            const createResp = await fetch("https://api.letz.ai/images", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${letzAiApiKey}`,
                },
                body: JSON.stringify({
                    prompt,
                    width,
                    height,
                    quality,
                    creativity,
                    hasWatermark,
                    systemVersion,
                    mode
                }),
            });


            const createData = await createResp.json();
            if (!createResp.ok) {
                callback({
                    text: `LetzAI creation failed: ${createData?.message || "Unknown error"}`,
                });
                return;
            }



            // 3) Let the user know we've started generating
            const { id, status, progress } = createData;
            callback({
                text: `Started generating your image. (ID: ${id}, status: ${status}, progress: ${progress}%)`,
            });

            // 4) Begin polling every 5s
            await pollLetzAiImageStatus(id, letzAiApiKey, callback, /* maxPolls */ 20, /* pollIntervalMs */ 5000);
        } catch (error: unknown) {
            callback({
                text: `Error while requesting LetzAI: ${error instanceof Error ? error.message : "Unknown error"}`,
            });
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate an image of a neon futuristic cityscape",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Sure, generating image via LetzAI...",
                    action: "GENERATE_IMAGE",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "Take a selfie" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Alright, hold on while I generate that selfie...",
                    action: "GENERATE_IMAGE",
                },
            },
            {
                user: "{{user1}}",
                content: { text: "Make an image of a man on the beach" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Making an image of a man on the beach!",
                    action: "GENERATE_IMAGE",
                },
            },
        ],

    ],
};

export const letzAIPlugin:Plugin = {
    name: "letzai",
    description: "LetzAI Image Generation Plugin",
    actions: [letzAiImageGeneration],
    evaluators: [],
    providers: [],
};

export default letzAIPlugin;
