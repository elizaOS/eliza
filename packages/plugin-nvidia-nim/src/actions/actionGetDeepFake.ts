import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, ActionExample, Media } from "@elizaos/core";
import axios from 'axios';
import fs from 'fs';
import { validateNvidiaNimConfig, getNetworkConfig, getConfig } from "../environment.js";
import { parseDeepFakePrompt } from "../utils/deepfakePromptParser.js";
import { DeepFakeContent, DeepFakeResponse, DeepFakeAnalysis } from "../types/deepfake.js";
import { AssetManager } from "../utils/assetManager.js";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";
import path from 'path';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.NVIDIA_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[DeepFakeDetection] ${message}`, data);
        console.log(`[DeepFakeDetection] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface ApiHeaders {
    Authorization: string;
    Accept: string;
    'Content-Type'?: string;
    'NVCF-INPUT-ASSET-REFERENCES'?: string;
    [key: string]: string | undefined;
}

export const getDeepFakeAction: Action = {
    name: "GET_DEEP_FAKE",
    similes: ["CHECK_DEEP_FAKE", "ANALYZE_DEEP_FAKE", "DEEP_FAKE_CONTROL"],
    description: "Use NVIDIA DeepFake detection model to analyze images for potential manipulation",
    examples: [[
        {
            user: "user",
            content: {
                text: "Check if this image is a deepfake please[IMAGE]\ntest_image.jpg\n[/IMAGE]",
                mediaPath: "test_image.jpg"
            } as DeepFakeContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "DeepFake Analysis: Image contains 1 face(s). Face #1: 99.82% likely to be a deepfake.",
                success: true,
                data: {
                    response: "Detected potential manipulation in the image",
                    analysis: [{
                        index: 0,
                        bounding_boxes: [{
                            vertices: [
                                { x: 167.92, y: 105.52 },
                                { x: 327.76, y: 327.61 }
                            ],
                            bbox_confidence: 0.9352,
                            is_deepfake: 0.9982
                        }],
                        status: "SUCCESS"
                    }]
                }
            } as DeepFakeContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_DEEP_FAKE") {
            return true;
        }

        logGranular("Validating GET_DEEP_FAKE action", {
            content: message.content
        });

        try {
            const content = message.content as DeepFakeContent;

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
            elizaLogger.error("Validation failed for GET_DEEP_FAKE", {
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
        logGranular("Executing GET_DEEPFAKE action");

        try {
            const messageContent = message.content as DeepFakeContent;
            console.log("Debug - Full message content:", {
                fullContent: message.content,
                rawText: messageContent?.text,
                type: message.content?.type,
                allKeys: Object.keys(message.content || {}),
                attachments: message.content?.attachments
            });

            console.log("Debug - Message content details:", {
                hasText: !!messageContent?.text,
                hasMediaFile: !!messageContent?.mediaFile,
                hasAttachments: !!message.content?.attachments?.length,
                textContent: messageContent?.text,
                mediaFile: messageContent?.mediaFile,
                contentType: typeof messageContent?.text,
                attachmentCount: message.content?.attachments?.length || 0,
                firstAttachmentUrl: message.content?.attachments?.[0]?.url,
                firstAttachmentType: message.content?.attachments?.[0]?.contentType
            });

            const config = await validateNvidiaNimConfig(runtime);
            console.log("Debug - Config validated:", {
                hasApiKey: !!config.NVIDIA_NIM_API_KEY,
                env: config.NVIDIA_NIM_ENV
            });

            const networkConfig = getNetworkConfig(config.NVIDIA_NIM_ENV);
            console.log("Debug - Network config:", {
                hasBaseUrl: !!networkConfig?.baseUrl,
                baseUrl: networkConfig?.baseUrl
            });

            // Parse the prompt using our helper
            console.log("Debug - Raw prompt:", {
                text: messageContent.text,
                hasMediaFile: !!messageContent.mediaFile,
                mediaFile: messageContent.mediaFile,
                promptLength: messageContent.text?.length,
                attachments: message.content?.attachments
            });

            const parsedPrompt = await parseDeepFakePrompt(
                messageContent.text,
                message.content?.attachments,
                config.NVIDIA_NIM_API_KEY
            );
            console.log("Debug - Parsed content:", {
                hasMediaFile: !!parsedPrompt.mediaFile,
                mediaPath: parsedPrompt.mediaFile,
                mediaLength: parsedPrompt.mediaFile?.length,
                isBase64: parsedPrompt.isBase64
            });

            let imageB64: string;
            let fileData: Buffer;
            let mediaPath: string = '';
            let workspaceRoot: string;
            let deepfakeDir: string;

            if (parsedPrompt.isBase64) {
                // Image is already in base64 format from chat
                console.log("Debug - Using base64 image from chat");
                imageB64 = parsedPrompt.mediaFile.split('base64,')[1]; // Remove the data:image/jpeg;base64, prefix
                fileData = Buffer.from(imageB64, 'base64');

                // Set up paths for potential temp file storage
                workspaceRoot = process.cwd().replace('/agent', '');
                while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
                    workspaceRoot = path.dirname(workspaceRoot);
                }
                deepfakeDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'deepfake');

                // Create temp file for base64 image
                const tempDir = path.join(deepfakeDir, 'temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                mediaPath = path.join(tempDir, `temp_${Date.now()}.jpg`);
                fs.writeFileSync(mediaPath, fileData);
            } else {
                // Image is a file path
                // Find the workspace root by looking for packages directory
                // workspaceRoot = process.cwd();
                workspaceRoot = process.cwd().replace('/agent', '');
                while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
                    workspaceRoot = path.dirname(workspaceRoot);
                }

                console.log("Debug - Workspace detection:", {
                    workspaceRoot,
                    hasPackagesDir: fs.existsSync(path.join(workspaceRoot, 'packages'))
                });

                deepfakeDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'deepfake');
                mediaPath = path.join(deepfakeDir, parsedPrompt.mediaFile);
                const absolutePath = path.resolve(mediaPath);

                console.log("Debug - File paths:", {
                    workspaceRoot,
                    deepfakeDir,
                    mediaPath,
                    absolutePath,
                    cwd: process.cwd(),
                    exists: fs.existsSync(mediaPath),
                    dirExists: fs.existsSync(deepfakeDir)
                });

                // Ensure deepfake directory exists
                if (!fs.existsSync(deepfakeDir)) {
                    console.log("Debug - Creating deepfake directory");
                    fs.mkdirSync(deepfakeDir, { recursive: true });
                }

                // Test file access
                try {
                    await fs.promises.access(mediaPath, fs.constants.R_OK);
                    console.log("Debug - File is readable at path:", mediaPath);

                    const stats = await fs.promises.stat(mediaPath);
                    console.log("Debug - File stats:", {
                        size: stats.size,
                        isFile: stats.isFile(),
                        permissions: stats.mode
                    });
                } catch (error) {
                    console.error("Debug - File access error:", {
                        error: error instanceof Error ? error.message : String(error),
                        path: mediaPath
                    });
                }

                // Ensure the file exists
                if (!fs.existsSync(mediaPath)) {
                    console.error(`Media file not found: ${mediaPath}`);
                    // Try listing directory contents
                    try {
                        const dirContents = await fs.promises.readdir(path.dirname(mediaPath));
                        console.log("Debug - Directory contents:", {
                            path: path.dirname(mediaPath),
                            files: dirContents
                        });
                    } catch (dirError) {
                        console.error("Debug - Failed to read directory:", dirError);
                    }
                    throw new NimError(
                        NimErrorCode.FILE_NOT_FOUND,
                        `Media file not found: ${mediaPath}`,
                        ErrorSeverity.HIGH
                    );
                }

                // Read the file
                console.log("Debug - Reading file from path");
                fileData = fs.readFileSync(mediaPath);
                imageB64 = fileData.toString('base64');
            }

            // ------------------------------------------------------------------------------------------------
            // Core DeepFake detection logic
            // ------------------------------------------------------------------------------------------------
            logGranular("Making request to NVIDIA NIM API", {
                model: "hive/deepfake-image-detection",
                hasMediaFile: true,
                imageSize: fileData.length,
                isBase64Image: parsedPrompt.isBase64
            });

            try {
                let payload;
                let headers: ApiHeaders = {
                    "Authorization": `Bearer ${config.NVIDIA_NIM_API_KEY}`,
                    "Accept": "application/json"
                };

                // Handle large files through asset upload
                if (imageB64.length < 180000) {
                    payload = {
                        input: [`data:image/jpeg;base64,${imageB64}`]
                    };
                    headers["Content-Type"] = "application/json";
                } else {
                    // For base64 images from chat, we need to save them first
                    let tempPath: string | null = null;
                    let uploadPath = mediaPath;
                    //let uploadPath = path.join(workspaceRoot, mediaPath);

                    if (parsedPrompt.isBase64) {
                        const tempDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'deepfake', 'temp');
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }
                        tempPath = path.join(tempDir, `temp_${Date.now()}_large.jpg`);
                        fs.writeFileSync(tempPath, fileData);
                        uploadPath = tempPath;
                    }

                    // Upload the file and get the asset ID
                    const assetManager = new AssetManager(config.NVIDIA_NIM_API_KEY);
                    const uploadedAsset = await assetManager.uploadAsset(uploadPath);

                    // Clean up temp file if we created one
                    if (tempPath && fs.existsSync(tempPath)) {
                        fs.unlinkSync(tempPath);
                    }

                    payload = {
                        input: [`data:image/jpeg;asset_id,${uploadedAsset.assetId}`]
                    };
                    headers["Content-Type"] = "application/json";
                    headers["NVCF-INPUT-ASSET-REFERENCES"] = uploadedAsset.assetId;
                }

                // Make the API request
                const apiUrl = 'https://ai.api.nvidia.com/v1/cv/hive/deepfake-image-detection';
                console.log("Debug - Making API request:", {
                    url: apiUrl,
                    payloadSize: JSON.stringify(payload).length,
                    hasAuth: !!headers.Authorization
                });

                const { data: response } = await axios.post(
                    apiUrl,
                    payload,
                    {
                        headers,
                        maxBodyLength: Infinity,
                        maxContentLength: Infinity
                    }
                );

                console.log("Debug - API Response received:", {
                    status: 'success',
                    dataLength: JSON.stringify(response).length
                });

                const deepfakeResponse = response as DeepFakeResponse;

                logGranular("Successfully received response from NVIDIA NIM", {
                    response: deepfakeResponse
                });

                // Process the analysis results
                const analysis: DeepFakeAnalysis = deepfakeResponse.data[0];

                logGranular("Processing analysis results", {
                    analysis
                });

                // Save the processed image if available
                let processedImagePath = '';
                if (analysis.image) {
                    const filename = `df_analysis_${Date.now()}.jpg`;
                    processedImagePath = path.join(deepfakeDir, filename);

                    // Ensure deepfake directory exists
                    if (!fs.existsSync(path.dirname(processedImagePath))) {
                        fs.mkdirSync(path.dirname(processedImagePath), { recursive: true });
                    }

                    // Convert base64 to image and save
                    const imageBuffer = Buffer.from(analysis.image.split(',')[1], 'base64');
                    fs.writeFileSync(processedImagePath, imageBuffer);

                    logGranular("Saved processed image", {
                        path: processedImagePath
                    });
                }

                const faceCount = analysis.bounding_boxes.length;
                const faceDescriptions = analysis.bounding_boxes.map((box, idx) =>
                    `Face #${idx + 1}: ${(box.is_deepfake * 100).toFixed(2)}% likely to be a deepfake`
                );

                const analysisText = `DeepFake Analysis: Image contains ${faceCount} face(s). ${faceDescriptions.join(". ")}${
                    processedImagePath ? `\n\nProcessed image saved to: ${processedImagePath}` : ''
                }`;

                const processedData = {
                    response: "Analyzed image for potential manipulation",
                    analysis: [analysis],
                    processedImage: processedImagePath || null
                };

                if (callback) {
                    callback({
                        text: analysisText,
                        success: true,
                        mediaPath,
                        data: processedData
                    } as DeepFakeContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to get response from NVIDIA NIM", { error });
                if (callback) {
                    callback({
                        text: `Error analyzing image: ${error instanceof Error ? error.message : String(error)}`,
                        success: false,
                        mediaPath: parsedPrompt.mediaFile,
                        data: {
                            error: error instanceof Error ? error.message : String(error)
                        }
                    } as DeepFakeContent);
                }
                throw new NimError(
                    NimErrorCode.API_ERROR,
                    "Failed to get response from NVIDIA NIM",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to execute GET_DEEP_FAKE action", { error });
            throw new NimError(
                NimErrorCode.NETWORK_ERROR,
                "Failed to execute GET_DEEP_FAKE action",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getDeepFakeAction;

