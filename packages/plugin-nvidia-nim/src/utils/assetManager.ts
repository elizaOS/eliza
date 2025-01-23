import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { MediaType, MediaAsset } from '../types/cosmos.js';
import { NimError, NimErrorCode, ErrorSeverity } from '../errors/nimErrors.js';

const SUPPORTED_FORMATS = {
    "png": ["image/png", "img"],
    "jpg": ["image/jpg", "img"],
    "jpeg": ["image/jpeg", "img"],
    "mp4": ["video/mp4", "video"]
} as const;

const ASSETS_DIR = path.join('packages', 'plugin-nvidia-nim', 'src', 'assets', 'cosmos');
const NVCF_ASSET_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/assets';

export class AssetManager {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Get the absolute path to the assets directory
     */
    private getAssetsPath(): string {
        // Try to find the assets directory relative to the current working directory
        let currentDir = process.cwd();
        let assetsPath = path.join(currentDir, ASSETS_DIR);

        // If not found, try parent directories
        while (!fs.existsSync(assetsPath) && currentDir !== path.parse(currentDir).root) {
            currentDir = path.dirname(currentDir);
            assetsPath = path.join(currentDir, ASSETS_DIR);
        }

        if (!fs.existsSync(assetsPath)) {
            throw new NimError(
                NimErrorCode.FILE_NOT_FOUND,
                "Assets directory not found",
                ErrorSeverity.HIGH
            );
        }

        return assetsPath;
    }

    /**
     * Get file information
     */
    private getFileInfo(filePath: string): { ext: string; mimeType: string; type: MediaType } {
        const ext = path.extname(filePath).toLowerCase().slice(1);
        if (!(ext in SUPPORTED_FORMATS)) {
            throw new NimError(
                NimErrorCode.VALIDATION_FAILED,
                `Unsupported file format: ${ext}`,
                ErrorSeverity.HIGH
            );
        }

        const [mimeType, type] = SUPPORTED_FORMATS[ext as keyof typeof SUPPORTED_FORMATS];
        return { ext, mimeType, type: type as MediaType };
    }

    /**
     * Check if a string is a valid URL
     */
    private isValidUrl(urlString: string): boolean {
        try {
            new URL(urlString);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Download a file from a URL and save it to the assets directory
     */
    async downloadFromUrl(url: string): Promise<string> {
        if (!this.isValidUrl(url)) {
            throw new NimError(
                NimErrorCode.VALIDATION_FAILED,
                "Invalid URL provided",
                ErrorSeverity.HIGH
            );
        }

        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'Accept': Object.values(SUPPORTED_FORMATS).map(([mime]) => mime).join(', ')
                }
            });

            const contentType = response.headers['content-type'];
            const extension = Object.entries(SUPPORTED_FORMATS)
                .find(([_, [mime]]) => mime === contentType)?.[0];

            if (!extension) {
                throw new NimError(
                    NimErrorCode.VALIDATION_FAILED,
                    `Unsupported content type: ${contentType}`,
                    ErrorSeverity.HIGH
                );
            }

            const assetsPath = this.getAssetsPath();
            const filename = `download_${Date.now()}.${extension}`;
            const filePath = path.join(assetsPath, filename);

            await fs.promises.writeFile(filePath, response.data);
            return filename;
        } catch (error) {
            if (error instanceof NimError) throw error;
            throw new NimError(
                NimErrorCode.DOWNLOAD_ERROR,
                "Failed to download media file",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }

    /**
     * Get or download media file
     * If the input is a URL, downloads it and returns the local path
     * If the input is a local file, validates it exists and returns the path
     */
    async getOrDownloadMedia(mediaInput: string): Promise<string> {
        if (this.isValidUrl(mediaInput)) {
            return this.downloadFromUrl(mediaInput);
        }

        // If not a URL, treat as local file
        const assetsPath = this.getAssetsPath();
        const filePath = path.join(assetsPath, mediaInput);

        if (!fs.existsSync(filePath)) {
            throw new NimError(
                NimErrorCode.FILE_NOT_FOUND,
                `Media file not found: ${mediaInput}`,
                ErrorSeverity.HIGH
            );
        }

        return mediaInput;
    }

    /**
     * Upload a media file to NVIDIA's asset service
     */
    async uploadAsset(filePath: string, description: string = "Reference media file"): Promise<MediaAsset> {
        const { mimeType, type } = this.getFileInfo(filePath);
        const fileData = fs.readFileSync(filePath);

        // First API call to authorize asset upload
        const headers = {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        };

        try {
            // Get upload URL
            const { data: authorizeRes } = await axios.post(NVCF_ASSET_URL, {
                contentType: mimeType,
                description
            }, { headers });

            // Upload the file
            await axios.put(authorizeRes.uploadUrl, fileData, {
                headers: {
                    "x-amz-meta-nvcf-asset-description": description,
                    "content-type": mimeType
                }
            });

            return {
                assetId: authorizeRes.assetId,
                type,
                mimeType,
                description
            };
        } catch (error) {
            throw new NimError(
                NimErrorCode.API_ERROR,
                "Failed to upload asset",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }

    /**
     * Delete an asset from NVIDIA's service
     */
    async deleteAsset(assetId: string): Promise<void> {
        try {
            await axios.delete(`${NVCF_ASSET_URL}/${assetId}`, {
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`
                }
            });
        } catch (error) {
            throw new NimError(
                NimErrorCode.API_ERROR,
                "Failed to delete asset",
                ErrorSeverity.LOW,
                { originalError: error }
            );
        }
    }

    /**
     * Get a list of available media files in the assets directory
     */
    listAvailableMedia(): string[] {
        const assetsPath = this.getAssetsPath();
        return fs.readdirSync(assetsPath)
            .filter(file => {
                const ext = path.extname(file).toLowerCase().slice(1);
                return ext in SUPPORTED_FORMATS;
            })
            .map(file => path.join(assetsPath, file));
    }

    /**
     * Get the full path to a media file in the assets directory
     */
    getMediaPath(filename: string): string {
        const assetsPath = this.getAssetsPath();
        const filePath = path.join(assetsPath, filename);

        if (!fs.existsSync(filePath)) {
            throw new NimError(
                NimErrorCode.FILE_NOT_FOUND,
                `Media file not found: ${filename}`,
                ErrorSeverity.HIGH
            );
        }

        return filePath;
    }

    /**
     * Handle a file uploaded through chat
     * This will copy the file to the appropriate assets directory and return the new path
     */
    async handleChatUpload(uploadPath: string, targetDir: string): Promise<string> {
        if (!fs.existsSync(uploadPath)) {
            throw new NimError(
                NimErrorCode.FILE_NOT_FOUND,
                `Upload file not found: ${uploadPath}`,
                ErrorSeverity.HIGH
            );
        }

        console.log("Debug - AssetManager - Input paths:", {
            uploadPath,
            targetDir,
            cwd: process.cwd()
        });

        // Find workspace root
        let workspaceRoot = process.cwd().replace('/agent', '');
        while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
            workspaceRoot = path.dirname(workspaceRoot);
        }

        // Convert targetDir to absolute path if it's relative
        const absoluteTargetDir = path.isAbsolute(targetDir)
            ? targetDir
            : path.join(workspaceRoot, targetDir);

        console.log("Debug - AssetManager - Resolved paths:", {
            workspaceRoot,
            absoluteTargetDir
        });

        // Ensure target directory exists
        if (!fs.existsSync(absoluteTargetDir)) {
            fs.mkdirSync(absoluteTargetDir, { recursive: true });
        }

        // Generate a new filename with timestamp
        const ext = path.extname(uploadPath);
        const timestamp = Date.now();
        const newFilename = `upload_${timestamp}${ext}`;
        const newPath = path.join(absoluteTargetDir, newFilename);

        console.log("Debug - AssetManager - File paths:", {
            newFilename,
            newPath,
            exists: fs.existsSync(uploadPath)
        });

        // Copy the file
        try {
            await fs.promises.copyFile(uploadPath, newPath);
            console.log("Debug - AssetManager - File copied successfully:", {
                from: uploadPath,
                to: newPath
            });
            return newPath;
        } catch (error) {
            throw new NimError(
                NimErrorCode.FILE_OPERATION_FAILED,
                `Failed to copy upload file: ${error instanceof Error ? error.message : String(error)}`,
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }

    /**
     * Handle image files for Cosmos
     * This includes validation, copying, and path management specific to Cosmos images
     */
    async handleImagesCosmos(uploadPath: string): Promise<string> {
        console.log("Debug - AssetManager - Handling Cosmos image:", {
            uploadPath,
            type: 'image'
        });

        // Find workspace root
        let workspaceRoot = process.cwd().replace('/agent', '');
        while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
            workspaceRoot = path.dirname(workspaceRoot);
        }

        // Set up Cosmos image directory
        const cosmosImageDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'cosmos', 'images');
        const cosmosTempDir = path.join(cosmosImageDir, 'temp');

        // Ensure directories exist
        if (!fs.existsSync(cosmosImageDir)) {
            fs.mkdirSync(cosmosImageDir, { recursive: true });
        }
        if (!fs.existsSync(cosmosTempDir)) {
            fs.mkdirSync(cosmosTempDir, { recursive: true });
        }

        // Validate file exists and is an image
        if (!fs.existsSync(uploadPath)) {
            throw new NimError(
                NimErrorCode.FILE_NOT_FOUND,
                `Image file not found: ${uploadPath}`,
                ErrorSeverity.HIGH
            );
        }

        const ext = path.extname(uploadPath).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
            throw new NimError(
                NimErrorCode.VALIDATION_FAILED,
                `Invalid image format: ${ext}`,
                ErrorSeverity.HIGH
            );
        }

        // Generate new filename and copy file
        const timestamp = Date.now();
        const newFilename = `cosmos_img_${timestamp}${ext}`;
        const newPath = path.join(cosmosImageDir, newFilename);

        try {
            await fs.promises.copyFile(uploadPath, newPath);
            console.log("Debug - AssetManager - Cosmos image processed:", {
                from: uploadPath,
                to: newPath,
                size: fs.statSync(newPath).size
            });
            return newPath;
        } catch (error) {
            throw new NimError(
                NimErrorCode.FILE_OPERATION_FAILED,
                `Failed to process Cosmos image: ${error instanceof Error ? error.message : String(error)}`,
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }

    /**
     * Handle video files for Cosmos
     * This includes validation, copying, and path management specific to Cosmos videos
     */
    async handleVideosCosmos(uploadPath: string): Promise<string> {
        console.log("Debug - AssetManager - Handling Cosmos video:", {
            uploadPath,
            type: 'video'
        });

        // Find workspace root
        let workspaceRoot = process.cwd().replace('/agent', '');
        while (!fs.existsSync(path.join(workspaceRoot, 'packages')) && workspaceRoot !== path.parse(workspaceRoot).root) {
            workspaceRoot = path.dirname(workspaceRoot);
        }

        // Set up Cosmos video directory
        const cosmosVideoDir = path.join(workspaceRoot, 'packages', 'plugin-nvidia-nim', 'src', 'assets', 'cosmos', 'videos');
        const cosmosTempDir = path.join(cosmosVideoDir, 'temp');

        // Ensure directories exist
        if (!fs.existsSync(cosmosVideoDir)) {
            fs.mkdirSync(cosmosVideoDir, { recursive: true });
        }
        if (!fs.existsSync(cosmosTempDir)) {
            fs.mkdirSync(cosmosTempDir, { recursive: true });
        }

        // Validate file exists and is a video
        if (!fs.existsSync(uploadPath)) {
            throw new NimError(
                NimErrorCode.FILE_NOT_FOUND,
                `Video file not found: ${uploadPath}`,
                ErrorSeverity.HIGH
            );
        }

        const ext = path.extname(uploadPath).toLowerCase();
        if (!['.mp4', '.avi', '.mov', '.webm'].includes(ext)) {
            throw new NimError(
                NimErrorCode.VALIDATION_FAILED,
                `Invalid video format: ${ext}`,
                ErrorSeverity.HIGH
            );
        }

        // Generate new filename and copy file
        const timestamp = Date.now();
        const newFilename = `cosmos_vid_${timestamp}${ext}`;
        const newPath = path.join(cosmosVideoDir, newFilename);

        try {
            await fs.promises.copyFile(uploadPath, newPath);
            console.log("Debug - AssetManager - Cosmos video processed:", {
                from: uploadPath,
                to: newPath,
                size: fs.statSync(newPath).size
            });
            return newPath;
        } catch (error) {
            throw new NimError(
                NimErrorCode.FILE_OPERATION_FAILED,
                `Failed to process Cosmos video: ${error instanceof Error ? error.message : String(error)}`,
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }

    /**
     * Updated handleChatUploadCosmos to use the new specialized handlers
     */
    async handleChatUploadCosmos(uploadPath: string, targetDir: string): Promise<string> {
        if (!fs.existsSync(uploadPath)) {
            throw new NimError(
                NimErrorCode.FILE_NOT_FOUND,
                `Upload file not found: ${uploadPath}`,
                ErrorSeverity.HIGH
            );
        }

        // Determine file type
        const ext = path.extname(uploadPath).toLowerCase();
        const isVideo = ['.mp4', '.avi', '.mov', '.webm'].includes(ext);
        const isImage = ['.jpg', '.jpeg', '.png', '.gif'].includes(ext);

        console.log("Debug - AssetManager - Cosmos upload type:", {
            path: uploadPath,
            extension: ext,
            isVideo,
            isImage
        });

        // Handle based on file type
        if (isVideo) {
            return this.handleVideosCosmos(uploadPath);
        } else if (isImage) {
            return this.handleImagesCosmos(uploadPath);
        } else {
            throw new NimError(
                NimErrorCode.VALIDATION_FAILED,
                `Unsupported file type: ${ext}`,
                ErrorSeverity.HIGH
            );
        }
    }
}