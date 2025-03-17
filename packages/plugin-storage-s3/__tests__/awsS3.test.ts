import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { type IAgentRuntime, ServiceType } from "@elizaos/core";
import { AwsS3Service } from "../src/services/awsS3";

// Mock the AWS SDK modules
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("node:fs");

describe("AwsS3Service", () => {
	let mockRuntime: IAgentRuntime;
	let service: AwsS3Service;
	
	beforeEach(() => {
		// Reset all mocks
		vi.resetAllMocks();
		
		// Setup mocks
		vi.mocked(S3Client).mockImplementation(() => ({
			send: vi.fn().mockResolvedValue({}),
			destroy: vi.fn(),
			config: {
				endpoint: vi.fn().mockResolvedValue({
					protocol: "https:",
					hostname: "test-endpoint.com",
					port: "",
					path: "/",
				}),
			},
		} as unknown as S3Client));
		
		vi.mocked(getSignedUrl).mockResolvedValue("https://signed-url.example.com/file.jpg");
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from("test file content"));
		
		// Mock runtime with settings
		mockRuntime = {
			getSetting: vi.fn((key) => {
				const settings: Record<string, string> = {
					AWS_ACCESS_KEY_ID: "test-access-key",
					AWS_SECRET_ACCESS_KEY: "test-secret-key",
					AWS_REGION: "us-west-2",
					AWS_S3_BUCKET: "test-bucket",
					AWS_S3_UPLOAD_PATH: "uploads/",
				};
				return settings[key] || null;
			}),
			getService: vi.fn(),
			env: {},
			getEnv: vi.fn(),
			character: {
				style: {
					all: [],
				},
			},
		} as unknown as IAgentRuntime;
		
		// Create service instance
		service = new AwsS3Service(mockRuntime);
	});
	
	afterEach(() => {
		vi.clearAllMocks();
	});
	
	describe("initialization", () => {
		it("should initialize with the correct service type", () => {
			expect(AwsS3Service.serviceType).toBe(ServiceType.REMOTE_FILES);
		});
		
		it("should set the capability description", () => {
			expect(service.capabilityDescription).toBe(
				"The agent is able to upload and download files from AWS S3"
			);
		});
		
		it("should initialize with the correct upload path from settings", () => {
			expect(mockRuntime.getSetting).toHaveBeenCalledWith("AWS_S3_UPLOAD_PATH");
			// We can't directly test private properties, but we'll verify through behavior
		});
	});
	
	describe("start", () => {
		it("should create a new instance and initialize it", async () => {
			const startedService = await AwsS3Service.start(mockRuntime);
			
			expect(startedService).toBeInstanceOf(AwsS3Service);
			// We can't directly access protected properties, but we can verify the instance was created
		});
	});
	
	describe("stop", () => {
		it("should destroy the S3 client if it exists", async () => {
			// Mock the private s3Client property using Object.defineProperty
			const mockDestroy = vi.fn();
			Object.defineProperty(service, 's3Client', {
				value: { destroy: mockDestroy },
				writable: true,
				configurable: true
			});
			
			await service.stop();
			
			expect(mockDestroy).toHaveBeenCalled();
		});
		
		it("should do nothing if S3 client doesn't exist", async () => {
			// Set s3Client to null
			Object.defineProperty(service, 's3Client', {
				value: null,
				writable: true,
				configurable: true
			});
			
			// This should not throw an error
			await service.stop();
		});
		
		it("should call service.stop when static stop is called", async () => {
			// Setup a mock service returned by getService
			const mockService = {
				stop: vi.fn(),
			};
			mockRuntime.getService.mockReturnValue(mockService);
			
			await AwsS3Service.stop(mockRuntime);
			
			expect(mockRuntime.getService).toHaveBeenCalledWith(ServiceType.REMOTE_FILES);
			expect(mockService.stop).toHaveBeenCalled();
		});
		
		it("should do nothing if no service is found", async () => {
			mockRuntime.getService.mockReturnValue(null);
			
			await AwsS3Service.stop(mockRuntime);
			
			expect(mockRuntime.getService).toHaveBeenCalledWith(ServiceType.REMOTE_FILES);
			// Should not throw an error
		});
	});
	
	describe("uploadFile", () => {
		beforeEach(() => {
			// Mock successful initialization of S3 client
			vi.spyOn(service as any, 'initializeS3Client').mockResolvedValue(true);
			
			// Mock the private s3Client property
			const mockSend = vi.fn().mockResolvedValue({});
			const mockEndpoint = vi.fn().mockResolvedValue({
				protocol: "https:",
				hostname: "test-endpoint.com",
				port: "",
				path: "/",
			});
			
			Object.defineProperty(service, 's3Client', {
				value: {
					send: mockSend,
					config: {
						endpoint: mockEndpoint
					}
				},
				writable: true,
				configurable: true
			});
			
			// Mock the private bucket property
			Object.defineProperty(service, 'bucket', {
				value: "test-bucket",
				writable: true,
				configurable: true
			});
			
			// Mock result from send method to simulate successful upload
			mockSend.mockResolvedValue({ success: true });
		});
		
		it("should upload a file successfully", async () => {
			// Setup
			const filePath = "/path/to/test.jpg";
			
			// Execute
			const result = await service.uploadFile(filePath);
			
			// Verify
			expect(result.success).toBe(true);
			expect(result.url).toBeDefined();
			expect(fs.existsSync).toHaveBeenCalledWith(filePath);
			expect(fs.readFileSync).toHaveBeenCalledWith(filePath);
			
			// Verify PutObjectCommand was called with correct params
			expect(PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
				Bucket: "test-bucket",
				ContentType: "image/jpeg",
			}));
		});
		
		it("should return error if file does not exist", async () => {
			// Setup
			vi.mocked(fs.existsSync).mockReturnValueOnce(false);
			const filePath = "/path/to/nonexistent.jpg";
			
			// Execute
			const result = await service.uploadFile(filePath);
			
			// Verify
			expect(result.success).toBe(false);
			expect(result.error).toBe("File does not exist");
		});
		
		it("should return error if AWS credentials are not configured", async () => {
			// Setup - mock initialization failure
			vi.spyOn(service as any, 'initializeS3Client').mockResolvedValueOnce(false);
			const filePath = "/path/to/test.jpg";
			
			// Execute
			const result = await service.uploadFile(filePath);
			
			// Verify
			expect(result.success).toBe(false);
			expect(result.error).toBe("AWS S3 credentials not configured");
		});
		
		it("should use signed URL when requested", async () => {
			// Setup
			const filePath = "/path/to/test.jpg";
			
			// Execute
			const result = await service.uploadFile(filePath, "", true, 3600);
			
			// Verify
			expect(result.success).toBe(true);
			expect(result.url).toBe("https://signed-url.example.com/file.jpg");
			expect(getSignedUrl).toHaveBeenCalled();
		});
		
		it("should handle upload errors", async () => {
			// Setup - mock send to throw an error
			const mockError = new Error("Upload failed");
			const s3Client = service['s3Client'] as any;
			s3Client.send.mockRejectedValueOnce(mockError);
			
			const filePath = "/path/to/test.jpg";
			
			// Execute
			const result = await service.uploadFile(filePath);
			
			// Verify
			expect(result.success).toBe(false);
			expect(result.error).toBe("Upload failed");
		});
		
		it("should use subdirectory when provided", async () => {
			// Setup
			const filePath = "/path/to/test.jpg";
			const subDirectory = "images";
			
			// Execute
			const result = await service.uploadFile(filePath, subDirectory);
			
			// Verify
			expect(result.success).toBe(true);
			
			// Verify the PutObjectCommand was created with correct params
			expect(PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
				Bucket: "test-bucket",
				Key: expect.stringContaining("uploads/images/"),
			}));
		});
	});
	
	describe("generateSignedUrl", () => {
		beforeEach(() => {
			// Mock successful initialization of S3 client
			vi.spyOn(service as any, 'initializeS3Client').mockResolvedValue(true);
			
			// Mock the private s3Client property
			Object.defineProperty(service, 's3Client', {
				value: {},
				writable: true,
				configurable: true
			});
			
			// Mock the private bucket property
			Object.defineProperty(service, 'bucket', {
				value: "test-bucket",
				writable: true,
				configurable: true
			});
		});
		
		it("should generate a signed URL for a file", async () => {
			// Execute
			const signedUrl = await service.generateSignedUrl("uploads/test.jpg", 3600);
			
			// Verify
			expect(signedUrl).toBe("https://signed-url.example.com/file.jpg");
			expect(getSignedUrl).toHaveBeenCalled();
			
			// Verify the GetObjectCommand was created with correct params
			expect(GetObjectCommand).toHaveBeenCalledWith({
				Bucket: "test-bucket",
				Key: "uploads/test.jpg",
			});
		});
		
		it("should throw error if AWS credentials are not configured", async () => {
			// Setup - mock initialization failure
			vi.spyOn(service as any, 'initializeS3Client').mockResolvedValue(false);
			
			// Execute & Verify
			await expect(service.generateSignedUrl("test.jpg")).rejects.toThrow(
				"AWS S3 credentials not configured"
			);
		});
	});
	
	describe("uploadJson", () => {
		beforeEach(() => {
			// Mock successful initialization of S3 client
			vi.spyOn(service as any, 'initializeS3Client').mockResolvedValue(true);
			
			// Mock the private s3Client property
			const mockSend = vi.fn().mockResolvedValue({});
			const mockEndpoint = vi.fn().mockResolvedValue({
				protocol: "https:",
				hostname: "test-endpoint.com",
				port: "",
				path: "/",
			});
			
			Object.defineProperty(service, 's3Client', {
				value: {
					send: mockSend,
					config: {
						endpoint: mockEndpoint
					}
				},
				writable: true,
				configurable: true
			});
			
			// Mock the private bucket property
			Object.defineProperty(service, 'bucket', {
				value: "test-bucket",
				writable: true,
				configurable: true
			});
			
			// Mock the private fileUploadPath property
			Object.defineProperty(service, 'fileUploadPath', {
				value: "uploads/",
				writable: true,
				configurable: true
			});
			
			// Mock result from send method to simulate successful upload
			mockSend.mockResolvedValue({ success: true });
		});
		
		it("should upload JSON data successfully", async () => {
			// Setup
			const jsonData = { test: "data", nested: { value: 123 } };
			
			// Execute
			const result = await service.uploadJson(jsonData, "test-file.json", "json-data");
			
			// Verify
			expect(result.success).toBe(true);
			expect(result.url).toBeDefined();
			expect(result.key).toBe("uploads/json-data/test-file.json");
			
			// Verify the PutObjectCommand was created with correct params
			expect(PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
				Bucket: "test-bucket",
				Key: "uploads/json-data/test-file.json",
				ContentType: "application/json",
				Body: JSON.stringify(jsonData, null, 2),
			}));
		});
		
		it("should generate a filename if not provided", async () => {
			// Setup
			const jsonData = { test: "data" };
			
			// Execute
			const result = await service.uploadJson(jsonData);
			
			// Verify
			expect(result.success).toBe(true);
			
			// Verify the PutObjectCommand was created with correct params
			expect(PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
				Bucket: "test-bucket",
				Key: expect.stringMatching(/uploads\/\d+\.json/),
				ContentType: "application/json",
			}));
		});
		
		it("should return error if JSON data is not provided", async () => {
			// Execute
			const result = await service.uploadJson(null as any);
			
			// Verify
			expect(result.success).toBe(false);
			expect(result.error).toBe("JSON data is required");
		});
		
		it("should use signed URL when requested", async () => {
			// Setup
			const jsonData = { test: "data" };
			
			// Mock getSignedUrl to return a specific URL
			vi.mocked(getSignedUrl).mockResolvedValueOnce("https://signed-url.example.com/file.jpg");
			
			// Execute
			const result = await service.uploadJson(jsonData, "test.json", "", true, 3600);
			
			// Verify
			expect(result.success).toBe(true);
			expect(result.url).toBe("https://signed-url.example.com/file.jpg");
			expect(getSignedUrl).toHaveBeenCalled();
		});
		
		it("should handle upload errors", async () => {
			// Setup - mock send to throw an error
			const mockError = new Error("Upload failed");
			const s3Client = service['s3Client'] as any;
			s3Client.send.mockRejectedValueOnce(mockError);
			
			const jsonData = { test: "data" };
			
			// Execute
			const result = await service.uploadJson(jsonData);
			
			// Verify
			expect(result.success).toBe(false);
			expect(result.error).toBe("Upload failed");
		});
	});
	
	describe("getContentType", () => {
		it("should return correct content type for image files", () => {
			// Test various file extensions
			const contentTypes = {
				"/path/to/image.png": "image/png",
				"/path/to/photo.jpg": "image/jpeg",
				"/path/to/picture.jpeg": "image/jpeg",
				"/path/to/animation.gif": "image/gif",
				"/path/to/image.webp": "image/webp",
				"/path/to/document.pdf": "application/octet-stream", // Default for unknown
			};
			
			// Test each file path
			for (const [filePath, expectedType] of Object.entries(contentTypes)) {
				const contentType = (service as any).getContentType(filePath);
				expect(contentType).toBe(expectedType);
			}
		});
	});
});
