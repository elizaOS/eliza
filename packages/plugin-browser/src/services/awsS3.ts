import fs from "node:fs";
import path from "node:path";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
	type IAgentRuntime,
	type IFileService,
	Service,
	ServiceType,
	type ServiceTypeName,
	logger,
} from "@elizaos/core";

/**
 * Interface representing the result of an upload operation.
 * @typedef {Object} UploadResult
 * @property {boolean} success - Indicates if the upload was successful or not.
 * @property {string} [url] - The URL of the uploaded file (optional).
 * @property {string} [error] - The error message in case the upload was unsuccessful (optional).
 */
interface UploadResult {
	success: boolean;
	url?: string;
	error?: string;
}

/**
 * Interface for the result of uploading a JSON file.
 * Extends UploadResult interface.
 *
 * @property {string} [key] - Optional storage key for the uploaded file.
 */
interface JsonUploadResult extends UploadResult {
	key?: string; // Add storage key
}

/**
 * Represents a service for interacting with AWS S3 to upload, download, and manage files.
 * @implements {IFileService}
 */
export class AwsS3Service extends Service implements IFileService {
	static serviceType: ServiceTypeName = ServiceType.REMOTE_FILES;
	capabilityDescription =
		"The agent is able to upload and download files from AWS S3";

	private s3Client: S3Client | null = null;
	private bucket = "";
	private fileUploadPath = "";
	protected runtime: IAgentRuntime | null = null;

	/**
	 * Constructor for a new instance of a class.
	 * @param {IAgentRuntime} runtime - The runtime object for the agent.
	 */
	constructor(runtime: IAgentRuntime) {
		super();
		this.runtime = runtime;
		this.fileUploadPath = runtime.getSetting("AWS_S3_UPLOAD_PATH") ?? "";
	}

	/**
	 * Initializes AwsS3Service with the given runtime and settings.
	 * @param {IAgentRuntime} runtime - The runtime object
	 * @returns {Promise<AwsS3Service>} - The AwsS3Service instance
	 */
	static async start(runtime: IAgentRuntime): Promise<AwsS3Service> {
		logger.log("Initializing AwsS3Service");
		const service = new AwsS3Service(runtime);
		service.runtime = runtime;
		service.fileUploadPath = runtime.getSetting("AWS_S3_UPLOAD_PATH") ?? "";
		return service;
	}

	/**
	 * Stops the remote file service.
	 *
	 * @param {IAgentRuntime} runtime - The agent runtime
	 * @returns {Promise<void>} - A promise that resolves once the service is stopped
	 */
	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceType.REMOTE_FILES);
		if (service) {
			await service.stop();
		}
	}

	/**
	 * Asynchronously stops the S3 client if it exists by destroying the client and setting it to null.
	 */
	async stop() {
		if (this.s3Client) {
			await this.s3Client.destroy();
			this.s3Client = null;
		}
	}

	/**
	 * Initializes the S3 client with the provided settings.
	 * If the S3 client is already initialized, it returns true.
	 * If any required setting is missing or invalid, it returns false.
	 *
	 * @returns A Promise that resolves to true if the S3 client is successfully initialized, false otherwise.
	 */
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
		const forcePathStyle = this.runtime.getSetting("AWS_S3_FORCE_PATH_STYLE");

		this.s3Client = new S3Client({
			...(endpoint ? { endpoint } : {}),
			...(sslEnabled ? { sslEnabled } : {}),
			...(forcePathStyle ? { forcePathStyle: Boolean(forcePathStyle) } : {}),
			region: AWS_REGION,
			credentials: {
				accessKeyId: AWS_ACCESS_KEY_ID,
				secretAccessKey: AWS_SECRET_ACCESS_KEY,
			},
		});
		this.bucket = AWS_S3_BUCKET;
		return true;
	}

	/**
	 * Uploads a file to AWS S3 with optional configuration options.
	 * @param {string} filePath - The path to the file to upload.
	 * @param {string} [subDirectory=""] - The subdirectory within the bucket to upload the file to.
	 * @param {boolean} [useSignedUrl=false] - Indicates whether to use a signed URL for the file.
	 * @param {number} [expiresIn=900] - The expiration time in seconds for the signed URL.
	 * @returns {Promise<UploadResult>} A promise that resolves to an object containing the upload result.
	 */
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
				result.url = await getSignedUrl(this.s3Client, getObjectCommand, {
					expiresIn, // 15 minutes in seconds
				});
			}

			return result;
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error ? error.message : "Unknown error occurred",
			};
		}
	}

	/**
	 * Generate signed URL for existing file
	 */
	/**
	 * Generates a signed URL for accessing the specified file in the S3 bucket.
	 *
	 * @param {string} fileName - The name of the file to generate a signed URL for.
	 * @param {number} expiresIn - The expiration time in seconds for the signed URL (default is 900 seconds).
	 * @returns {Promise<string>} A promise that resolves with the signed URL for accessing the file.
	 * @throws {Error} If AWS S3 credentials are not configured properly.
	 */
	async generateSignedUrl(fileName: string, expiresIn = 900): Promise<string> {
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
				result.url = await getSignedUrl(this.s3Client, getObjectCommand, {
					expiresIn,
				});
			}

			return result;
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof Error ? error.message : "Unknown error occurred",
			};
		}
	}
}

export default AwsS3Service;
