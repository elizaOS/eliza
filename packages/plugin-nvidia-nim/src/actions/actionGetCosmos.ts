import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from "@elizaos/core";
import { validateNvidiaNimConfig, getNetworkConfig, getConfig } from "../environment.js";
import { parseCosmosPrompt } from "../utils/cosmosPromptParser.js";
import { CosmosContent, CosmosResponse, CosmosAnalysis } from "../types/cosmos.js";
import { AssetManager } from "../utils/assetManager.js";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";
import path from 'path';
import axios from 'axios';
import fs from 'fs';


// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.NVIDIA_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[CosmosVision] ${message}`, data);
        console.log(`[CosmosVision] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

// Get URLs from environment config
const invoke_url = config.NVIDIA_COSMOS_INVOKE_URL || "https://ai.api.nvidia.com/v1/vlm/nvidia/cosmos-nemotron-34b";
const kNvcfAssetUrl = config.NVIDIA_COSMOS_ASSET_URL || "https://api.nvcf.nvidia.com/v2/nvcf/assets";

// Get API key with proper error handling
function getApiKey(config: any): string {
    const apiKey = config.NVIDIA_NIM_API_KEY || process.env.TEST_NVCF_API_KEY;
    if (!apiKey) {
        throw new NimError(
            NimErrorCode.VALIDATION_FAILED,
            "API key is missing. Please set NVIDIA_NIM_API_KEY or TEST_NVCF_API_KEY.",
            ErrorSeverity.HIGH
        );
    }
    return apiKey;
}

// Type definitions for supported formats
type SupportedExtension = 'png' | 'jpg' | 'jpeg' | 'mp4';
type MediaInfo = [string, string]; // [mimeType, mediaType]

const kSupportedList: Record<SupportedExtension, MediaInfo> = {
    "png": ["image/png", "img"],
    "jpg": ["image/jpg", "img"],
    "jpeg": ["image/jpeg", "img"],
    "mp4": ["video/mp4", "video"]
} as const;

// Get file extension
function getExtension(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    return ext.slice(1); // remove the leading dot
}

// Get MIME type
function mimeType(ext: SupportedExtension): string {
    return kSupportedList[ext][0];
}

// Get media type
function mediaType(ext: SupportedExtension): string {
    return kSupportedList[ext][1];
}

export const getCosmosDescriptionAction: Action = {
    name: "GET_COSMOS_DESCRIPTION",
    similes: ["CHECK_COSMOS_DESCRIPTION", "ANALYZE_COSMOS_DESCRIPTION", "COSMOS_DESCRIPTION_CONTROL"],
    description: "Use NVIDIA Cosmos model to analyze and describe images or videos",
    examples: [[
        {
            user: "user",
            content: {
                text: "Analyze this image with the NVIDIA Cosmos [MEDIA]\nsample.jpg\n[/MEDIA]\n[QUERY]\nDescribe what's happening in this image\n[/QUERY]",
                mediaPath: "sample.jpg"
            } as CosmosContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Scene Analysis: A person wearing a hard hat and safety vest is working in an industrial setting.",
                success: true,
                data: {
                    response: "The worker, who is wearing a neon vest, black pants, and a yellow hard hat, is pulling a yellow caution tape across the aisle. This action suggests that he is cordoning off the area, likely for safety or maintenance reasons.",
                    analysis: {
                        description: "The worker, who is wearing a neon vest, black pants, and a yellow hard hat, is pulling a yellow caution tape across the aisle. This action suggests that he is cordoning off the area, likely for safety or maintenance reasons.",
                        confidence: 0.92
                    }
                }
            } as CosmosContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_COSMOS_DESCRIPTION") {
            return true;
        }

        logGranular("Validating GET_COSMOS_DESCRIPTION action", {
            content: message.content
        });

        try {
            const content = message.content as CosmosContent;

            if (!content.text) {
                throw new NimError(
                    NimErrorCode.VALIDATION_FAILED,
                    "text content is required",
                    ErrorSeverity.HIGH
                );
            }

            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            elizaLogger.error("Validation failed for GET_COSMOS_DESCRIPTION", {
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_COSMOS_DESCRIPTION action");

        try {
            const messageContent = message.content as CosmosContent;
            const config = await validateNvidiaNimConfig(runtime);
            const networkConfig = getNetworkConfig(config.NVIDIA_NIM_ENV);
            const apiKey = getApiKey(config);

            logGranular("API key configuration", {
                hasKey: !!apiKey,
                length: apiKey?.length,
                source: config.NVIDIA_NIM_API_KEY ? 'config' : process.env.TEST_NVCF_API_KEY ? 'env' : 'default'
            });

            // Parse the prompt using our helper
            const parsedPrompt = await parseCosmosPrompt(messageContent.text);
            logGranular("Parsed prompt", parsedPrompt);

            if (!parsedPrompt.mediaFile) {
                throw new NimError(
                    NimErrorCode.VALIDATION_FAILED,
                    "No media file provided in the prompt",
                    ErrorSeverity.HIGH
                );
            }

            // Initialize asset manager
            const assetManager = new AssetManager(config.NVIDIA_NIM_API_KEY);

            // ------------------------------------------------------------------------------------------------
            // Core Cosmos vision analysis logic
            // ------------------------------------------------------------------------------------------------
            logGranular("Making request to NVIDIA NIM API", {
                model: "nvidia/cosmos-nemotron-34b",
                query: parsedPrompt.query,
                mediaFile: parsedPrompt.mediaFile,
                isVideo: parsedPrompt.isVideo,
                isImage: parsedPrompt.isImage
            });

            console.log("Debug - Network config", {
                baseVisionUrl: networkConfig.baseVisionUrl
            });

            try {
                // Handle the media file using new Cosmos-specific methods
                let mediaPath;
                if (parsedPrompt.isVideo) {
                    logGranular("Processing video file", {
                        originalPath: parsedPrompt.mediaFile,
                        type: 'video'
                    });
                    mediaPath = await assetManager.handleVideosCosmos(parsedPrompt.mediaFile);
                    logGranular("Video file processed", {
                        originalPath: parsedPrompt.mediaFile,
                        processedPath: mediaPath
                    });
                } else if (parsedPrompt.isImage) {
                    logGranular("Processing image file", {
                        originalPath: parsedPrompt.mediaFile,
                        type: 'image'
                    });
                    mediaPath = await assetManager.handleImagesCosmos(parsedPrompt.mediaFile);
                    logGranular("Image file processed", {
                        originalPath: parsedPrompt.mediaFile,
                        processedPath: mediaPath
                    });
                } else {
                    // Use the general handler if type is not specified
                    const cosmosDir = path.join('packages', 'plugin-nvidia-nim', 'src', 'assets', 'cosmos');
                    logGranular("Processing media file using general handler", {
                        originalPath: parsedPrompt.mediaFile,
                        targetDir: cosmosDir
                    });
                    mediaPath = await assetManager.handleChatUploadCosmos(parsedPrompt.mediaFile, cosmosDir);
                    logGranular("Media file processed using general handler", {
                        originalPath: parsedPrompt.mediaFile,
                        processedPath: mediaPath
                    });
                }

                logGranular("Processing file extension", {
                    mediaPath,
                    fullPath: path.resolve(mediaPath)
                });

                const ext = path.extname(mediaPath).toLowerCase().slice(1) as SupportedExtension;
                if (!(ext in kSupportedList)) {
                    const error = `Unsupported file extension: ${ext}`;
                    logGranular("File extension error", {
                        ext,
                        supportedExtensions: Object.keys(kSupportedList)
                    });
                    throw new Error(error);
                }

                logGranular("File extension validated", {
                    ext,
                    mimeType: kSupportedList[ext][0],
                    mediaType: kSupportedList[ext][1]
                });

                const dataInput = fs.readFileSync(mediaPath);
                logGranular("File read", {
                    size: dataInput.length,
                    mediaPath
                });

                const description = "Reference media file";

                // First API call to authorize asset upload - exact same as nvidia.ts
                const headers = {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                };

                const postData = {
                    contentType: kSupportedList[ext][0],
                    description: description
                };

                logGranular("Initiating asset upload authorization", {
                    headers: {
                        ...headers,
                        "Authorization": "Bearer [REDACTED]"
                    },
                    postData
                });

                const { data: authorizeRes } = await axios.post(kNvcfAssetUrl, postData, { headers });

                logGranular("Asset upload authorized", {
                    uploadUrl: authorizeRes.uploadUrl,
                    assetId: authorizeRes.assetId
                });

                // Second API call to upload the file - exact same as nvidia.ts
                const uploadHeaders = {
                    "x-amz-meta-nvcf-asset-description": description,
                    "content-type": kSupportedList[ext][0]
                };

                logGranular("Uploading file to authorized URL", {
                    uploadUrl: authorizeRes.uploadUrl,
                    headers: uploadHeaders,
                    fileSize: dataInput.length
                });

                const uploadResponse = await axios.put(authorizeRes.uploadUrl, dataInput, {
                    headers: uploadHeaders
                });

                if (uploadResponse.status !== 200) {
                    const error = `Asset upload failed: ${authorizeRes.assetId}`;
                    logGranular("Upload failed", {
                        status: uploadResponse.status,
                        assetId: authorizeRes.assetId,
                        response: uploadResponse.data
                    });
                    throw new Error(error);
                }

                const assetId = authorizeRes.assetId;
                logGranular("Asset upload successful", {
                    assetId,
                    status: uploadResponse.status
                });

                // Construct media content exactly as in nvidia.ts
                const mediaContent = `<${kSupportedList[ext][1]} src="data:${kSupportedList[ext][0]};asset_id,${assetId}" />`;
                const promptContent = `${parsedPrompt.query || 'Describe this'} ${mediaContent}`;

                logGranular("Constructed media content", {
                    mediaContent,
                    fullPrompt: promptContent
                });

                const messages = [{
                    role: "user",
                    content: promptContent
                }];

                // Headers exactly as in nvidia.ts
                const inferHeaders = {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "NVCF-INPUT-ASSET-REFERENCES": assetId,
                    "NVCF-FUNCTION-ASSET-IDS": assetId
                };

                const payload = {
                    max_tokens: 1024,
                    temperature: 0.2,
                    top_p: 0.7,
                    seed: 50,
                    num_frames_per_inference: 8,
                    messages: messages,
                    stream: false,
                    model: "nvidia/vila"
                };

                logGranular("Preparing Cosmos API request", {
                    url: invoke_url,
                    headers: {
                        ...inferHeaders,
                        "Authorization": "Bearer [REDACTED]"
                    },
                    payload: {
                        ...payload,
                        messages: messages
                    }
                });

                const response = await axios.post(
                    invoke_url,
                    payload,
                    { headers: inferHeaders }
                );

                logGranular("Received Cosmos API response", {
                    status: response.status,
                    headers: response.headers,
                    data: response.data
                });

                // Clean up the asset - exact same as nvidia.ts
                logGranular("Initiating asset cleanup", { assetId });

                await axios.delete(`${kNvcfAssetUrl}/${assetId}`, {
                    headers: {
                        "Authorization": `Bearer ${apiKey}`
                    }
                });

                logGranular("Asset cleanup completed", { assetId });

                const responseText = response.data.choices[0]?.message?.content || "";
                const cosmosResponse = {
                    ...response.data,
                    prompt_logprobs: null
                };

                const analysis: CosmosAnalysis = {
                    description: responseText,
                    confidence: 0.92
                };

                logGranular("Processing complete", {
                    responseLength: responseText.length,
                    success: true,
                    assetId
                });

                if (callback) {
                    callback({
                        text: `Scene Analysis: ${responseText}`,
                        success: true,
                        mediaPath,
                        data: {
                            response: responseText,
                            analysis,
                            raw: cosmosResponse,
                            assetId
                        }
                    } as CosmosContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to get response from NVIDIA NIM", { error });
                if (callback) {
                    callback({
                        text: `Error analyzing media: ${error instanceof Error ? error.message : String(error)}`,
                        success: false,
                        mediaPath: parsedPrompt.mediaFile,
                        data: {
                            error: error instanceof Error ? error.message : String(error)
                        }
                    } as CosmosContent);
                }
                throw new NimError(
                    NimErrorCode.API_ERROR,
                    "Failed to get response from NVIDIA NIM",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to execute GET_COSMOS_DESCRIPTION action", { error });
            throw new NimError(
                NimErrorCode.NETWORK_ERROR,
                "Failed to execute GET_COSMOS_DESCRIPTION action",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getCosmosDescriptionAction;

