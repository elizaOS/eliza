import {
    type IAgentRuntime,
    type IAwsS3Service,
    Service,
    ServiceType,
    elizaLogger,
} from "@elizaos/core";
import {
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "node:fs";
import * as path from "node:path";

interface UploadResult {
    success: boolean;
    url?: string;
    error?: string;
}

interface JsonUploadResult extends UploadResult {
    key?: string; // Add storage key
}

export class AwsS3Service extends Service implements IAwsS3Service {
    static serviceType: ServiceType = ServiceType.AWS_S3;

    private s3Client: S3Client | null = null;
    private bucket = "";
    private fileUploadPath = "";
    private runtime: IAgentRuntime | null = null;

    async initialize(runtime: IAgentRuntime): Promise<void> {
        elizaLogger.log("Initializing AwsS3Service");
        this.runtime = runtime;
        this.fileUploadPath = runtime.getSetting("AWS_S3_UPLOAD_PATH") ?? "";
    }

    private async initializeS3Client(): Promise<boolean> {
        if (this.s3Client) return true;
        if (!this.runtime) return false;

        const AWS_ACCESS_KEY_ID = this.runtime.getSetting("AWS_ACCESS_KEY_ID");
        const AWS_SECRET_ACCESS_KEY = this.runtime.getSetting(
            "AWS_SECRET_ACCESS_KEY",
        );
        const AWS_REGION = this.runtime.getSetting("AWS_REGION");
        const AWS_S3_BUCKET = this.runtime.getSetting("AWS_S3_BUCKET");

        if (
            !AWS_ACCESS_KEY_ID ||
            !AWS_SECRET_ACCESS_KEY ||
            !AWS_REGION ||
            !AWS_S3_BUCKET
        ) {
            return false;
        }

        // Optional fields to allow for other providers
        const endpoint = this.runtime.getSetting("AWS_S3_ENDPOINT");
        const sslEnabled = this.runtime.getSetting("AWS_S3_SSL_ENABLED");
        const forcePathStyle = this.runtime.getSetting(
            "AWS_S3_FORCE_PATH_STYLE",
        );

        this.s3Client = new S3Client({
            ...(endpoint ? { endpoint } : {}),
            ...(sslEnabled ? { sslEnabled } : {}),
            ...(forcePathStyle
                ? { forcePathStyle: Boolean(forcePathStyle) }
                : {}),
            region: AWS_REGION,
            credentials: {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
            },
        });
        this.bucket = AWS_S3_BUCKET;
        return true;
    }

    async uploadFile(
        filePath: string,
        subDirectory = "",
        useSignedUrl = false,
        expiresIn = 900,
    ): Promise<UploadResult> {
        try {
            if (!(await this.initializeS3Client())) {
                return {
                    success: false,
                    error: "AWS S3 credentials not configured",
                };
            }

            if (!fs.existsSync(filePath)) {
                return {
                    success: false,
                    error: "File does not exist",
                };
            }

            const fileContent = fs.readFileSync(filePath);

            const baseFileName = `${Date.now()}-${path.basename(filePath)}`;
            // Determine storage path based on public access
            const fileName =
                `${this.fileUploadPath}${subDirectory}/${baseFileName}`.replaceAll(
                    "//",
                    "/",
                );
            // Set upload parameters
            const uploadParams = {
                Bucket: this.bucket,
                Key: fileName,
                Body: fileContent,
                ContentType: this.getContentType(filePath),
            };

            // Upload file
            await this.s3Client.send(new PutObjectCommand(uploadParams));

            // Build result object
            const result: UploadResult = {
                success: true,
            };

            // If not using signed URL, return either custom endpoint or public access URL
            if (!useSignedUrl) {
                if (this.s3Client.config.endpoint) {
                    const endpoint = await this.s3Client.config.endpoint();
                    const port = endpoint.port ? `:${endpoint.port}` : "";
                    result.url = `${endpoint.protocol}//${endpoint.hostname}${port}${endpoint.path}${this.bucket}/${fileName}`;
                } else {
                    result.url = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
                }
            } else {
                const getObjectCommand = new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: fileName,
                });
                result.url = await getSignedUrl(
                    this.s3Client,
                    getObjectCommand,
                    {
                        expiresIn, // 15 minutes in seconds
                    },
                );
            }

            return result;
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown error occurred",
            };
        }
    }

    /**
     * Generate signed URL for existing file
     */
    async generateSignedUrl(
        fileName: string,
        expiresIn = 900,
    ): Promise<string> {
        if (!(await this.initializeS3Client())) {
            throw new Error("AWS S3 credentials not configured");
        }

        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: fileName,
        });

        return await getSignedUrl(this.s3Client, command, { expiresIn });
    }

    private getContentType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes: { [key: string]: string } = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
        };
        return contentTypes[ext] || "application/octet-stream";
    }

    /**
     * Upload JSON object to S3
     * @param jsonData JSON data to upload
     * @param fileName File name (optional, without path)
     * @param subDirectory Subdirectory (optional)
     * @param useSignedUrl Whether to use signed URL
     * @param expiresIn Signed URL expiration time (seconds)
     */
    async uploadJson(
        jsonData: any,
        fileName?: string,
        subDirectory?: string,
        useSignedUrl = false,
        expiresIn = 900,
    ): Promise<JsonUploadResult> {
        try {
            if (!(await this.initializeS3Client())) {
                return {
                    success: false,
                    error: "AWS S3 credentials not configured",
                };
            }

            // Validate input
            if (!jsonData) {
                return {
                    success: false,
                    error: "JSON data is required",
                };
            }

            // Generate filename (if not provided)
            const timestamp = Date.now();
            const actualFileName = fileName || `${timestamp}.json`;

            // Build complete file path
            let fullPath = this.fileUploadPath || "";
            if (subDirectory) {
                fullPath = `${fullPath}/${subDirectory}`.replace(/\/+/g, "/");
            }
            const key = `${fullPath}/${actualFileName}`.replace(/\/+/g, "/");

            // Convert JSON to string
            const jsonString = JSON.stringify(jsonData, null, 2);

            // Set upload parameters
            const uploadParams = {
                Bucket: this.bucket,
                Key: key,
                Body: jsonString,
                ContentType: "application/json",
            };

            // Upload file
            await this.s3Client.send(new PutObjectCommand(uploadParams));

            // Build result
            const result: JsonUploadResult = {
                success: true,
                key: key,
            };

            // If not using signed URL, return either custom endpoint or public access URL
            if (!useSignedUrl) {
                if (this.s3Client.config.endpoint) {
                    const endpoint = await this.s3Client.config.endpoint();
                    const port = endpoint.port ? `:${endpoint.port}` : "";
                    result.url = `${endpoint.protocol}//${endpoint.hostname}${port}${endpoint.path}${this.bucket}/${key}`;
                } else {
                    result.url = `https://${this.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
                }
            } else {
                const getObjectCommand = new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                });
                result.url = await getSignedUrl(
                    this.s3Client,
                    getObjectCommand,
                    { expiresIn },
                );
            }

            return result;
        } catch (error) {
            return {
                success: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Unknown error occurred",
            };
        }
    }
}

export default AwsS3Service;
