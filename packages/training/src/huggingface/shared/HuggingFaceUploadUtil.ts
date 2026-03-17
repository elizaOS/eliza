/**
 * HuggingFace Upload Utility
 *
 * Shared utility for uploading files to HuggingFace Hub.
 * Consolidates upload logic used across different services.
 */

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as hubModule from "@huggingface/hub";
import { logger } from "../../utils/logger";

export interface UploadFileOptions {
  repo: { type: "model" | "dataset"; name: string };
  file: { path: string; content: Blob };
  credentials: { accessToken: string };
}

export interface CreateRepoOptions {
  repo: { type: "model" | "dataset"; name: string };
  credentials: { accessToken: string };
  private?: boolean;
}

/**
 * Get HuggingFace token from environment variables
 *
 * Checks both HUGGING_FACE_TOKEN and HF_TOKEN for compatibility
 * with different HuggingFace tooling conventions.
 *
 * @returns Token string or undefined if not set
 */
export function getHuggingFaceToken(): string | undefined {
  return process.env.HUGGING_FACE_TOKEN || process.env.HF_TOKEN;
}

/**
 * Get HuggingFace token or throw error if not set
 *
 * @throws Error if token is not configured
 * @returns Token string
 */
export function requireHuggingFaceToken(): string {
  const token = getHuggingFaceToken();
  if (!token) {
    throw new Error(
      "HuggingFace token not configured. Set HUGGING_FACE_TOKEN or HF_TOKEN environment variable.",
    );
  }
  return token;
}

/**
 * Upload a single file to HuggingFace Hub
 */
export async function uploadFileToHub(
    repoName: string,
    repoType: "model" | "dataset",
    filePath: string,
    fileContent: string,
    token: string,
  ): Promise<void> {
    const uploadFile = hubModule.uploadFile;

    await uploadFile({
      repo: { type: repoType, name: repoName },
      file: {
        path: filePath,
        content: new Blob([fileContent]),
      },
      credentials: {
        accessToken: token,
      },
    });

    logger.info(`Uploaded ${filePath} to ${repoName}`, {
      repo: repoName,
      type: repoType,
    });
}

/**
 * Upload directory to HuggingFace Hub
 */
export async function uploadDirectoryToHub(
    repoName: string,
    repoType: "model" | "dataset",
    localDir: string,
    token: string,
  ): Promise<number> {
    const files = await fs.readdir(localDir);
    let uploadCount = 0;

    for (const file of files) {
      const filePath = path.join(localDir, file);
      const stats = await fs.stat(filePath);

      if (stats.isFile()) {
        const content = await fs.readFile(filePath, "utf-8");

        await uploadFileToHub(
          repoName,
          repoType,
          file,
          content,
          token,
        );
        uploadCount++;
      }
    }

    logger.info(`Uploaded ${uploadCount} files to ${repoName}`, {
      repo: repoName,
      count: uploadCount,
    });

    return uploadCount;
}

/**
 * Ensure repository exists (create if needed)
 */
export async function ensureHubRepository(
    repoName: string,
    repoType: "model" | "dataset",
    token: string,
    isPrivate = false,
  ): Promise<void> {
    const createRepo = hubModule.createRepo;

    try {
      await createRepo({
        repo: { type: repoType, name: repoName },
        credentials: { accessToken: token },
        private: isPrivate,
      });
      logger.info("Created new repository", { repo: repoName, type: repoType });
    } catch (error) {
      // Repository might already exist, which is fine
      if (
        error instanceof Error &&
        (error.message.includes("already exists") ||
          error.message.includes("Repository not found"))
      ) {
        logger.info("Repository already exists or accessible", {
          repo: repoName,
        });
      } else {
        logger.warn("Could not ensure repository exists", {
          error,
          repo: repoName,
        });
      }
    }
}

/**
 * Upload using huggingface-cli (fallback method)
 */
export async function uploadViaCLI(
    repoName: string,
    repoType: "model" | "dataset",
    localDir: string,
    token: string,
  ): Promise<void> {
    try {
      const execAsync = promisify(exec);

      // Set token as environment variable
      process.env.HUGGINGFACE_HUB_TOKEN = token;

      console.log(
        `Uploading ${localDir} to ${repoName} via huggingface-cli...`,
      );

      await execAsync(
        `huggingface-cli upload ${repoName} ${localDir} --repo-type ${repoType}`,
      );

      logger.info("Successfully uploaded via huggingface-cli", {
        repo: repoName,
      });
    } catch (error) {
      logger.error("CLI upload failed", { error });
      throw error;
    }
}

/**
 * Provide manual upload instructions
 */
export function getManualUploadInstructions(
    repoName: string,
    repoType: "model" | "dataset",
    localDir: string,
  ): string[] {
    return [
      "1. Install huggingface-cli: pip install huggingface_hub",
      "2. Login: huggingface-cli login",
      `3. Upload: huggingface-cli upload ${repoName} ${localDir} --repo-type ${repoType}`,
    ];
}

/** @deprecated Use uploadFileToHub, uploadDirectoryToHub, etc. instead */
export const HuggingFaceUploadUtil = {
  uploadFile: uploadFileToHub,
  uploadDirectory: uploadDirectoryToHub,
  ensureRepository: ensureHubRepository,
  uploadViaCLI,
  getManualUploadInstructions,
};
