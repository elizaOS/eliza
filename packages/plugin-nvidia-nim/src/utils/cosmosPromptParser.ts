import { Media } from "@elizaos/core";
import { AssetManager } from "./assetManager.js";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";
import path from 'path';
import process from 'process';
import fs from 'fs';

// Debug logging helper
const debugLog = (message: string, data?: unknown) => {
    console.log(`Debug - Cosmos Parser - ${message}:`, data);
};

export interface CosmosParsedPrompt {
    mediaFile?: string;
    query?: string;
    isVideo: boolean;
    isImage: boolean;
    isBase64: boolean;
}

/**
 * Parse a prompt for Cosmos Vision processing
 * Supports both traditional [MEDIA]...[/MEDIA] format and direct file uploads
 */
export const parseCosmosPrompt = async (text?: string, attachments?: Media[], apiKey?: string): Promise<CosmosParsedPrompt> => {
    debugLog("Input", {
        hasText: !!text,
        textLength: text?.length,
        attachmentCount: attachments?.length,
        hasApiKey: !!apiKey
    });

    const result: CosmosParsedPrompt = {
        isVideo: false,
        isImage: false,
        isBase64: false
    };

    // Get workspace root using the same logic as actionGetDeepFake.ts
    let workspaceRoot = process.cwd().replace('/agent', '');
    while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
        workspaceRoot = path.dirname(workspaceRoot);
    }

    debugLog("Workspace paths", {
        cwd: process.cwd(),
        workspaceRoot,
        hasPackagesDir: fs.existsSync(path.join(workspaceRoot, 'packages'))
    });

    if (!text && !attachments?.length) {
        return result;
    }

    // Handle direct file uploads first
    if (attachments?.length) {
        const firstAttachment = attachments[0];
        debugLog("First attachment", {
            id: firstAttachment.id,
            contentType: firstAttachment.contentType,
            url: firstAttachment.url
        });

        // Determine media type from content type
        const contentType = firstAttachment.contentType || '';
        const isVideo = contentType.startsWith('video/');
        const isImage = contentType.startsWith('image/');

        if (!isVideo && !isImage) {
            throw new NimError(
                NimErrorCode.VALIDATION_FAILED,
                "Unsupported media type. Only images and videos are supported.",
                ErrorSeverity.HIGH
            );
        }

        // Use AssetManager to handle the upload
        if (apiKey) {
            const assetManager = new AssetManager(apiKey);
            const uploadPath = firstAttachment.url;
            const cosmosDir = path.join('packages', 'plugin-nvidia-nim', 'src', 'assets', 'cosmos');
            const fullCosmosDir = path.join(workspaceRoot, cosmosDir);

            debugLog("Upload paths", {
                uploadPath,
                cosmosDir,
                fullCosmosDir
            });

            try {
                const newPath = await assetManager.handleChatUploadCosmos(uploadPath, cosmosDir);
                result.mediaFile = path.basename(newPath);
                result.isVideo = isVideo;
                result.isImage = isImage;
                result.isBase64 = false;

                debugLog("Upload result", {
                    newPath,
                    mediaFile: result.mediaFile
                });
            } catch (error) {
                throw new NimError(
                    NimErrorCode.FILE_OPERATION_FAILED,
                    `Failed to process uploaded file: ${error instanceof Error ? error.message : String(error)}`,
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        }

        // Extract query from text if present
        if (text) {
            const queryMatch = text.match(/\[QUERY\](.*?)\[\/QUERY\]/s);
            result.query = queryMatch ? queryMatch[1].trim() : text.trim();
        }

        return result;
    }

    // Handle text-based prompt with [MEDIA]...[/MEDIA] tags
    if (text) {
        const mediaMatch = text.match(/\[MEDIA\](.*?)\[\/MEDIA\]/s);
        const queryMatch = text.match(/\[QUERY\](.*?)\[\/QUERY\]/s);

        debugLog("Text matches", {
            hasMediaMatch: !!mediaMatch,
            hasQueryMatch: !!queryMatch,
            mediaContent: mediaMatch?.[1]?.trim(),
            queryContent: queryMatch?.[1]?.trim()
        });

        if (mediaMatch) {
            const mediaFile = mediaMatch[1].trim();
            // Build the correct path for local files
            const cosmosDir = path.join('packages', 'plugin-nvidia-nim', 'src', 'assets', 'cosmos');
            const fullCosmosDir = path.join(workspaceRoot, cosmosDir);
            const mediaPath = path.join(fullCosmosDir, mediaFile);

            debugLog("Local file paths", {
                mediaFile,
                cosmosDir,
                fullCosmosDir,
                mediaPath
            });

            result.mediaFile = mediaPath;

            // Determine file type
            const ext = path.extname(mediaFile).toLowerCase();
            result.isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);
            result.isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
        }

        if (queryMatch) {
            result.query = queryMatch[1].trim();
        }
    }

    debugLog("Result", {
        hasMediaFile: !!result.mediaFile,
        isVideo: result.isVideo,
        isImage: result.isImage,
        isBase64: result.isBase64,
        hasQuery: !!result.query,
        fullPath: result.mediaFile
    });

    return result;
}

/**
 * Creates a formatted Cosmos prompt string
 */
export function createCosmosPrompt(mediaFile: string, query: string = "Describe the scene"): string {
    return `[MEDIA]
${mediaFile}
[/MEDIA]
[QUERY]
${query}
[/QUERY]`;
}