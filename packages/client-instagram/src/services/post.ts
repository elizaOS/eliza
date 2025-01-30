// src/services/post.ts
import {
    type IAgentRuntime,
    ModelClass,
    composeContext,
    elizaLogger,
    generateImage,
    generateText,
    getEmbeddingZeroVector,
    stringToUuid,
} from "@elizaos/core";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { getIgClient } from "../lib/state";
import type { InstagramState } from "../types";

// Template for generating Instagram posts
const instagramPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{instagramUsername}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}.
Your response should be 1-3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only.
Add up to 3 relevant hashtags at the end.`;

interface PostOptions {
    media: Array<{
        type: "IMAGE" | "VIDEO" | "CAROUSEL";
        url: string;
    }>;
    caption?: string;
}

export class InstagramPostService {
    private runtime: IAgentRuntime;
    private state: InstagramState;
    private isProcessing = false;
    private lastPostTime = 0;
    private stopProcessing = false;

    constructor(runtime: IAgentRuntime, state: InstagramState) {
        this.runtime = runtime;
        this.state = state;
    }

    async start() {
        const generatePostLoop = async () => {
            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>("instagram/lastPost");

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const minMinutes = Number.parseInt(
                this.runtime.getSetting("INSTAGRAM_POST_INTERVAL_MIN") || this.runtime.getSetting("POST_INTERVAL_MIN") || "90",
                10
            );
            const maxMinutes = Number.parseInt(
                this.runtime.getSetting("INSTAGRAM_POST_INTERVAL_MAX") || this.runtime.getSetting("POST_INTERVAL_MAX") || "180",
                10
            );
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewPost();
            }

            if (!this.stopProcessing) {
                setTimeout(generatePostLoop, delay);
            }

            elizaLogger.log(
                `Next Instagram post scheduled in ${randomMinutes} minutes`
            );
        };

        // Start the loop
        generatePostLoop();
    }

    async stop() {
        this.stopProcessing = true;
    }

    private async generateNewPost() {
        try {
            elizaLogger.log("Generating new Instagram post");

            const roomId = stringToUuid(
                "instagram_generate_room-" + this.state.profile?.username
            );

            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.state.profile?.username || "",
                this.runtime.character.name,
                "instagram"
            );

            const topics = this.runtime.character.topics.join(", ");

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics || "",
                        action: "POST",
                    },
                },
                {
                    instagramUsername: this.state.profile?.username,
                }
            );

            const context = composeContext({
                state,
                // TODO: Add back in when we have a template for Instagram on character
                //template: this.runtime.character.templates?.instagramPostTemplate || instagramPostTemplate,
                template: instagramPostTemplate,
            });

            elizaLogger.debug("generate post prompt:\n" + context);

            const content = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Clean the generated content
            let cleanedContent = "";

            // Try parsing as JSON first
            try {
                const parsedResponse = JSON.parse(content);
                if (parsedResponse.text) {
                    cleanedContent = parsedResponse.text;
                } else if (typeof parsedResponse === "string") {
                    cleanedContent = parsedResponse;
                }
            } catch {
                // If not JSON, clean the raw content
                cleanedContent = content
                    .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
                    .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
                    .replace(/\\"/g, '"') // Unescape quotes
                    .replace(/\\n/g, "\n\n") // Unescape newlines
                    .trim();
            }

            if (!cleanedContent) {
                elizaLogger.error(
                    "Failed to extract valid content from response:",
                    {
                        rawResponse: content,
                        attempted: "JSON parsing",
                    }
                );
                return;
            }

            // For Instagram, we need to generate or get an image
            const mediaUrl = await this.getOrGenerateImage(cleanedContent);

            await this.createPost({
                media: [
                    {
                        type: "IMAGE",
                        url: mediaUrl,
                    },
                ],
                caption: cleanedContent,
            });

            // Create memory of the post
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(`instagram-post-${Date.now()}`),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: cleanedContent,
                    source: "instagram",
                },
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: Date.now(),
            });
        } catch (error) {
            elizaLogger.error("Error generating Instagram post:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "generateNewPost",
            });
        }
    }

    // Placeholder - implement actual image generation/selection
    private async getOrGenerateImage(content: string): Promise<string> {
        try {
            elizaLogger.log("Generating image for Instagram post");

            let imageSettings = this.runtime.character.settings.imageSettings || {};

            const result = await generateImage(
                {
                    prompt: content,
                    width: imageSettings?.width || 1024,
                    height: imageSettings?.height || 1024,
                    count: imageSettings?.count || 1,
negativePrompt: imageSettings?.negativePrompt || null,
                    numIterations: imageSettings?.numIterations || 50,
                    guidanceScale: imageSettings?.guidanceScale || 7.5,
seed: imageSettings?.seed || null,
                    modelId: imageSettings?.modelId || null,
                    jobId: imageSettings?.jobId || null,
                    stylePreset: imageSettings?.stylePreset || "",
                    hideWatermark: imageSettings?.hideWatermark ?? true,
                    safeMode: imageSettings?.safeMode ?? true,
                    cfgScale: imageSettings?.cfgScale || null,
                },
                this.runtime
            );

            if (!result.success || !result.data || result.data.length === 0) {
                throw new Error(
                    "Failed to generate image: " +
                        (result.error || "No image data returned")
                );
            }

            // Save the base64 image to a temporary file
            const imageData = result.data[0].replace(
                /^data:image\/\w+;base64,/,
                ""
            );
            const tempDir = path.resolve(process.cwd(), "temp");
            await fs.mkdir(tempDir, { recursive: true });
            const tempFile = path.join(
                tempDir,
                `instagram-post-${Date.now()}.png`
            );
            await fs.writeFile(tempFile, Buffer.from(imageData, "base64"));

            return tempFile;
        } catch {
            // If not JSON, clean the raw content
            cleanedContent = content
              .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
              .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
              .replace(/\\"/g, '"') // Unescape quotes
              .replace(/\\n/g, "\n\n") // Unescape newlines
              .trim();
        }

      if (!cleanedContent) {
        elizaLogger.error("Failed to extract valid content from response:", {
          rawResponse: content,
          attempted: "JSON parsing",
        });
        return;
      }

      // For Instagram, we need to generate or get an image
      const mediaUrl = await this.getOrGenerateImage(cleanedContent);

      await this.createPost({
        media: [{
          type: 'IMAGE',
          url: mediaUrl
        }],
        caption: cleanedContent
      });

      // Create memory of the post
      await this.runtime.messageManager.createMemory({
        id: stringToUuid(`instagram-post-${Date.now()}`),
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: {
          text: cleanedContent,
          source: "instagram",
        },
        roomId,
        embedding: getEmbeddingZeroVector(),
        createdAt: Date.now(),
      });

    } catch (error) {
      elizaLogger.error("Error generating Instagram post:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        phase: 'generateNewPost'
      });
    }

    async createPost(options: PostOptions) {
        const ig = getIgClient();

        try {
            elizaLogger.log("Creating Instagram post", {
                mediaCount: options.media.length,
                hasCaption: !!options.caption,
            });

            // Process media
            const processedMedia = await Promise.all(
                options.media.map(async (media) => {
                    const buffer = await this.processMedia(media);
                    return {
                        ...media,
                        buffer,
                    };
                })
            );

            // Handle different post types
            if (processedMedia.length > 1) {
                // Create carousel post
                await ig.publish.album({
                    items: processedMedia.map((media) => ({
                        file: media.buffer,
                        caption: options.caption,
                    })),
                });
            } else {
                // Single image/video post
                const media = processedMedia[0];
                if (media.type === "VIDEO") {
                    await ig.publish.video({
                        video: media.buffer,
                        caption: options.caption,
                        coverImage: media.buffer,
                    });
                } else {
                    await ig.publish.photo({
                        file: media.buffer,
                        caption: options.caption,
                    });
                }
            }

            // Update last post time
            this.lastPostTime = Date.now();
            await this.runtime.cacheManager.set("instagram/lastPost", {
                timestamp: this.lastPostTime,
            });

            elizaLogger.log("Instagram post created successfully");
        } catch (error) {
            elizaLogger.error("Error creating Instagram post:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "createPost",
                mediaCount: options.media.length,
                hasCaption: !!options.caption,
            });
            throw error;
        }
    }

    private async processMedia(media: {
        type: string;
        url: string;
    }): Promise<Buffer> {
        try {
            elizaLogger.log("Processing media", {
                type: media.type,
                url: media.url,
            });

            // Read file directly from filesystem instead of using fetch
            const buffer = await fs.readFile(media.url);

            if (media.type === "IMAGE") {
                // Process image with sharp
                return await sharp(buffer)
                    .resize(1080, 1080, {
                        fit: "inside",
                        withoutEnlargement: true,
                    })
                    .jpeg({
                        quality: 85,
                        progressive: true,
                    })
                    .toBuffer();
            }

            // For other types, return original buffer
            return buffer;
        } catch (error) {
            elizaLogger.error("Error processing media:", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                phase: "processMedia",
                mediaType: media.type,
                url: media.url,
            });
            throw error;
        }
    }
}
