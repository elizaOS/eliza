import { Media } from "@elizaos/core";
import { AssetManager } from "./assetManager.js";
import path from 'path';

import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";

interface ParsedAIImagePrompt {
    mediaFile: string;
    isBase64: boolean;
}

/**
 * Parses a prompt string to extract the media file for AI image analysis
 * Format expected either:
 * [IMAGE]
 * path/to/image/file
 * [/IMAGE]
 *
 * or
 *
 * [IMAGE]
 * data:image/jpeg;base64,...
 * [/IMAGE]
 *
 * or directly from message attachments
 */
export async function parseAIImagePrompt(text: string, attachments?: Media[], apiKey?: string): Promise<ParsedAIImagePrompt> {
    try {
        // First check for attachments
        if (attachments && attachments.length > 0) {
            const imageAttachment = attachments[0];
            if (!imageAttachment.url) {
                throw new Error("Invalid media attachment: no URL found");
            }

            // Handle the uploaded file
            if (apiKey) {
                const assetManager = new AssetManager(apiKey);
                const aiImageDir = path.join('packages', 'plugin-nvidia-nim', 'src', 'assets', 'aiimage');
                const newPath = await assetManager.handleChatUpload(imageAttachment.url, aiImageDir);

                return {
                    mediaFile: path.basename(newPath),
                    isBase64: false
                };
            }

            return {
                mediaFile: imageAttachment.url,
                isBase64: imageAttachment.url.startsWith('data:image')
            };
        }

        // If no attachments, try to parse from text
        const mediaMatch = text.match(/\[IMAGE\]([\s\S]*?)\[\/IMAGE\]/);

        if (!mediaMatch) {
            throw new Error("Image file path or data is required");
        }

        const mediaContent = mediaMatch[1].trim();
        const isBase64 = mediaContent.startsWith('data:image');

        return {
            mediaFile: mediaContent,
            isBase64
        };
    } catch (error) {
        if (error instanceof NimError) {
            throw error;
        }
        throw new NimError(
            NimErrorCode.PARSE_ERROR,
            "Failed to parse AI image prompt",
            ErrorSeverity.HIGH,
            { originalError: error }
        );
    }
}

/**
 * Creates a formatted AI image analysis prompt string
 */
export function createAIImagePrompt(mediaFile: string): string {
    return `[IMAGE]
${mediaFile}
[/IMAGE]`;
}