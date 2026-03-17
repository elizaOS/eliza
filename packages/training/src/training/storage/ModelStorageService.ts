/**
 * Model Storage Service (Vercel Blob)
 *
 * Handles model versioning and storage using Vercel Blob.
 * Stores trained models with metadata for easy deployment.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { del, list, put } from "@vercel/blob";
import type { JsonValue } from "../../adapter";
import { getTrainingDataAdapter } from "../../adapter";
import { logger } from "../../utils/logger";

export interface ModelMetadata {
  trainingBatch?: string;
  accuracy?: number;
  avgReward?: number;
  baseModel?: string;
  modelIdPrefix?: string;
}

export interface ModelVersion {
  version: string;
  baseModel: string;
  blobUrl: string;
  size: number;
  uploadedAt: Date;
  metadata: ModelMetadata & Record<string, JsonValue | undefined>;
}

export class ModelStorageService {
  private readonly blobPrefix = "models/";

  /**
   * Upload trained model to Vercel Blob
   */
  async uploadModel(options: {
    version: string;
    modelPath: string;
    modelIdPrefix?: string;
    metadata?: ModelVersion["metadata"];
  }): Promise<ModelVersion> {
    logger.info("Uploading model to Vercel Blob", {
      version: options.version,
      path: options.modelPath,
    });

    // Read model file
    const modelData = await fs.readFile(options.modelPath);
    const fileName = path.basename(options.modelPath);

    // Upload to Vercel Blob
    const blob = await put(
      `${this.blobPrefix}${options.version}/${fileName}`,
      modelData,
      {
        access: "public", // Models can be publicly downloaded
        addRandomSuffix: false,
      },
    );

    // Upload metadata
    await put(
      `${this.blobPrefix}${options.version}/metadata.json`,
      JSON.stringify(options.metadata || {}, null, 2),
      {
        access: "public",
        addRandomSuffix: false,
      },
    );

    logger.info("Model uploaded to Vercel Blob", {
      version: options.version,
      url: blob.url,
      size: (blob as { size?: number }).size || 0,
    });

    const metadataModelIdPrefix =
      typeof options.metadata?.modelIdPrefix === "string"
        ? options.metadata.modelIdPrefix
        : undefined;
    const modelIdPrefix =
      options.modelIdPrefix ||
      metadataModelIdPrefix ||
      process.env.TRAINING_MODEL_ID_PREFIX ||
      "eliza-agent";

    // Save to database via adapter
    const adapter = getTrainingDataAdapter();
    await adapter.insertModel({
      id: `model-${Date.now()}`,
      modelId: `${modelIdPrefix}-${options.version}`,
      version: options.version,
      baseModel:
        (options.metadata?.baseModel as string) || "unsloth/Qwen3-4B-128K",
      trainingBatch: (options.metadata?.trainingBatch as string) || null,
      status: "ready",
      deployedAt: null,
      archivedAt: null,
      storagePath: blob.url,
      benchmarkScore: null,
      accuracy: (options.metadata?.accuracy as number) || null,
      avgReward: (options.metadata?.avgReward as number) || null,
      evalMetrics: null,
      wandbRunId: null,
      wandbArtifactId: null,
      huggingFaceRepo: null,
      agentsUsing: 0,
      totalInferences: 0,
      lastBenchmarked: null,
      benchmarkCount: 0,
      updatedAt: new Date(),
    });

    return {
      version: options.version,
      baseModel:
        (options.metadata?.baseModel as string) || "unsloth/Qwen3-4B-128K",
      blobUrl: blob.url,
      size: (blob as { size?: number }).size || 0,
      uploadedAt: new Date(),
      metadata: options.metadata || {},
    };
  }

  /**
   * Download model from Vercel Blob
   */
  async downloadModel(version: string): Promise<{
    modelData: Buffer;
    metadata: ModelVersion["metadata"];
  }> {
    const adapter = getTrainingDataAdapter();
    const model = await adapter.getModelByVersion(version);

    if (!model) {
      throw new Error(`Model version ${version} not found`);
    }

    // Download model file
    const modelResponse = await fetch(model.storagePath);
    const modelData = Buffer.from(await modelResponse.arrayBuffer());

    // Download metadata
    const metadataUrl = model.storagePath.replace(/\/[^/]+$/, "/metadata.json");
    const metadataResponse = await fetch(metadataUrl);
    const metadata =
      (await metadataResponse.json()) as ModelVersion["metadata"];

    return {
      modelData,
      metadata,
    };
  }

  /**
   * List all model versions
   */
  async listModels(): Promise<ModelVersion[]> {
    const { blobs } = await list({
      prefix: this.blobPrefix,
    });

    // Group by version
    interface BlobInfo {
      url: string;
      pathname: string;
      size: number;
      uploadedAt: string | Date;
    }

    interface VersionData {
      version: string;
      blobs: BlobInfo[];
    }

    const versions = new Map<string, VersionData>();

    for (const blob of blobs) {
      const parts = blob.pathname.split("/");
      const version = parts[1];
      if (!version) continue;

      if (!versions.has(version)) {
        versions.set(version, {
          version,
          blobs: [],
        });
      }
      // Convert uploadedAt to string if it's a Date
      const blobInfo: BlobInfo = {
        ...blob,
        uploadedAt:
          blob.uploadedAt instanceof Date
            ? blob.uploadedAt.toISOString()
            : blob.uploadedAt,
      };
      versions.get(version)?.blobs.push(blobInfo);
    }

    // Get metadata for each version
    const models: ModelVersion[] = [];

    for (const [version, data] of versions) {
      const modelBlob = data.blobs.find(
        (b: BlobInfo) =>
          b.pathname.endsWith(".safetensors") || b.pathname.endsWith(".bin"),
      );

      if (modelBlob) {
        // Try to get metadata
        let metadata: ModelVersion["metadata"] = {};
        try {
          const metadataBlob = data.blobs.find((b: BlobInfo) =>
            b.pathname.endsWith("metadata.json"),
          );
          if (metadataBlob) {
            const response = await fetch(metadataBlob.url);
            metadata = (await response.json()) as ModelVersion["metadata"];
          }
        } catch {
          // No metadata, use defaults
        }

        models.push({
          version,
          baseModel: metadata.baseModel || "unknown",
          blobUrl: modelBlob.url,
          size: modelBlob.size,
          uploadedAt:
            modelBlob.uploadedAt instanceof Date
              ? modelBlob.uploadedAt
              : new Date(modelBlob.uploadedAt),
          metadata,
        });
      }
    }

    return models.sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
    );
  }

  /**
   * Delete model version
   */
  async deleteModel(version: string): Promise<void> {
    const { blobs } = await list({
      prefix: `${this.blobPrefix}${version}/`,
    });

    for (const blob of blobs) {
      await del(blob.url);
    }

    // Update database via adapter
    const adapter = getTrainingDataAdapter();
    const model = await adapter.getModelByVersion(version);
    if (model) {
      await adapter.updateModelStatus(model.modelId, "archived", {
        archivedAt: new Date(),
      });
    }

    logger.info("Model deleted from Vercel Blob", { version });
  }

  /**
   * Get latest model version
   */
  async getLatestVersion(): Promise<ModelVersion | null> {
    const models = await this.listModels();
    return models[0] || null;
  }
}

// Singleton
export const modelStorage = new ModelStorageService();
