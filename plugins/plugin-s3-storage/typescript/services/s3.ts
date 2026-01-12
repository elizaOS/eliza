import fs from "node:fs";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service, ServiceType } from "@elizaos/core";

import type { JsonUploadResult, JsonValue, UploadResult } from "../types";
import { getContentType } from "../types";

export class AwsS3Service extends Service {
  static serviceType = ServiceType.REMOTE_FILES;
  capabilityDescription = "The agent is able to upload and download files from AWS S3";

  private s3Client: S3Client | null = null;
  private bucket = "";
  private fileUploadPath = "";

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
    if (runtime) {
      const uploadPath = runtime.getSetting("AWS_S3_UPLOAD_PATH");
      this.fileUploadPath = typeof uploadPath === "string" ? uploadPath : "";
    }
  }

  static async start(runtime: IAgentRuntime): Promise<AwsS3Service> {
    logger.log("Initializing AwsS3Service");
    const service = new AwsS3Service(runtime);
    const uploadPath = runtime.getSetting("AWS_S3_UPLOAD_PATH");
    service.fileUploadPath = typeof uploadPath === "string" ? uploadPath : "";
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ServiceType.REMOTE_FILES);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.s3Client) {
      await this.s3Client.destroy();
      this.s3Client = null;
    }
  }

  /**
   * Get the S3 client, throwing if not initialized
   */
  private getClient(): S3Client {
    if (!this.s3Client) {
      throw new Error("S3 client not initialized");
    }
    return this.s3Client;
  }

  private async initializeS3Client(): Promise<boolean> {
    if (this.s3Client) return true;
    if (!this.runtime) {
      throw new Error("Runtime not initialized");
    }

    const AWS_ACCESS_KEY_ID = this.runtime.getSetting("AWS_ACCESS_KEY_ID");
    const AWS_SECRET_ACCESS_KEY = this.runtime.getSetting("AWS_SECRET_ACCESS_KEY");
    const AWS_REGION = this.runtime.getSetting("AWS_REGION");
    const AWS_S3_BUCKET = this.runtime.getSetting("AWS_S3_BUCKET");

    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION || !AWS_S3_BUCKET) {
      return false;
    }

    const endpoint = this.runtime.getSetting("AWS_S3_ENDPOINT");
    const sslEnabled = this.runtime.getSetting("AWS_S3_SSL_ENABLED");
    const forcePathStyle = this.runtime.getSetting("AWS_S3_FORCE_PATH_STYLE");

    this.s3Client = new S3Client({
      ...(endpoint ? { endpoint: String(endpoint) } : {}),
      ...(sslEnabled !== undefined ? { sslEnabled: Boolean(sslEnabled) } : {}),
      ...(forcePathStyle !== undefined ? { forcePathStyle: Boolean(forcePathStyle) } : {}),
      region: String(AWS_REGION),
      credentials: {
        accessKeyId: String(AWS_ACCESS_KEY_ID),
        secretAccessKey: String(AWS_SECRET_ACCESS_KEY),
      },
    });
    this.bucket = String(AWS_S3_BUCKET);
    return true;
  }

  async uploadFile(
    filePath: string,
    subDirectory = "",
    useSignedUrl = false,
    expiresIn = 900
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
      const fileName = `${this.fileUploadPath}${subDirectory}/${baseFileName}`.replaceAll(
        "//",
        "/"
      );

      const client = this.getClient();
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: fileName,
          Body: fileContent,
          ContentType: getContentType(filePath),
        })
      );

      const result: UploadResult = { success: true };

      if (!useSignedUrl) {
        if (client.config.endpoint) {
          const endpoint = await client.config.endpoint();
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
        result.url = await getSignedUrl(client, getObjectCommand, {
          expiresIn,
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async generateSignedUrl(fileName: string, expiresIn = 900): Promise<string> {
    if (!(await this.initializeS3Client())) {
      throw new Error("AWS S3 credentials not configured");
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileName,
    });

    const client = this.getClient();
    return await getSignedUrl(client, command, { expiresIn });
  }

  async uploadJson(
    jsonData: Record<string, JsonValue>,
    fileName?: string,
    subDirectory?: string,
    useSignedUrl = false,
    expiresIn = 900
  ): Promise<JsonUploadResult> {
    try {
      if (!(await this.initializeS3Client())) {
        return {
          success: false,
          error: "AWS S3 credentials not configured",
        };
      }

      if (!jsonData) {
        return {
          success: false,
          error: "JSON data is required",
        };
      }

      const timestamp = Date.now();
      const actualFileName = fileName || `${timestamp}.json`;

      let fullPath = this.fileUploadPath || "";
      if (subDirectory) {
        fullPath = `${fullPath}/${subDirectory}`.replace(/\/+/g, "/");
      }
      const key = `${fullPath}/${actualFileName}`.replace(/\/+/g, "/");

      const jsonString = JSON.stringify(jsonData, null, 2);
      const client = this.getClient();

      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: jsonString,
          ContentType: "application/json",
        })
      );

      const result: JsonUploadResult = {
        success: true,
        key: key,
      };

      if (!useSignedUrl) {
        if (client.config.endpoint) {
          const endpoint = await client.config.endpoint();
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
        result.url = await getSignedUrl(client, getObjectCommand, {
          expiresIn,
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async uploadBytes(
    data: Buffer | Uint8Array,
    fileName: string,
    contentType: string,
    subDirectory = "",
    useSignedUrl = false,
    expiresIn = 900
  ): Promise<UploadResult> {
    try {
      if (!(await this.initializeS3Client())) {
        return {
          success: false,
          error: "AWS S3 credentials not configured",
        };
      }

      const key = `${this.fileUploadPath}${subDirectory}/${fileName}`.replace(/\/+/g, "/");
      const client = this.getClient();

      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
        })
      );

      const result: UploadResult = { success: true };

      if (!useSignedUrl) {
        if (client.config.endpoint) {
          const endpoint = await client.config.endpoint();
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
        result.url = await getSignedUrl(client, getObjectCommand, {
          expiresIn,
        });
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export default AwsS3Service;
