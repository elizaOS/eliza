import { Media } from "@elizaos/core";
import { AssetManager } from "./assetManager.js";
import path from 'path';

interface DeepFakeParsedPrompt {
    mediaFile: string;
    isBase64: boolean;
}

interface MessageAttachment {
    data: string;
    type: string;
    name?: string;
}

/**
 * Parses a prompt string to extract the media file for deepfake detection
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
export async function parseDeepFakePrompt(text: string, attachments?: Media[], apiKey?: string): Promise<DeepFakeParsedPrompt> {
    // First check for attachments
    if (attachments && attachments.length > 0) {
        const imageAttachment = attachments[0];
        if (!imageAttachment.url) {
            throw new Error("Invalid media attachment: no URL found");
        }

        // Handle the uploaded file
        if (apiKey) {
            const assetManager = new AssetManager(apiKey);
            const deepfakeDir = path.join('packages', 'plugin-nvidia-nim', 'src', 'assets', 'deepfake');
            const newPath = await assetManager.handleChatUpload(imageAttachment.url, deepfakeDir);

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
}

/**
 * Creates a formatted deepfake detection prompt string
 */
export function createDeepFakePrompt(mediaFile: string): string {
    return `[IMAGE]
${mediaFile}
[/IMAGE]`;
}