/**
 * Training Data Archiver (Vercel Blob)
 *
 * Archives training data (exported trajectories, RULER scores) to Vercel Blob
 * for long-term storage and reproducibility.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { del, list, put } from "@vercel/blob";
import type { JsonValue } from "../../adapter";
import { logger } from "../../utils/logger";

export interface ArchivedWindow {
  windowId: string;
  trajectoryCount: number;
  blobUrls: {
    trajectories: string;
    groups?: string;
    rulerScores?: string;
    metadata: string;
  };
  archivedAt: Date;
  size: number;
}

export class TrainingDataArchiver {
  private readonly blobPrefix = "training-data/";

  /**
   * Archive training data for a window
   */
  async archiveWindow(options: {
    windowId: string;
    trajectoriesPath: string;
    groupsPath?: string;
    rulerScoresPath?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ArchivedWindow> {
    logger.info("Archiving training data", { windowId: options.windowId });

    const prefix = `${this.blobPrefix}${options.windowId}/`;
    interface BlobUrls {
      trajectories: string;
      groups?: string;
      rulerScores?: string;
      metadata: string;
    }
    const urls: BlobUrls = {
      trajectories: "",
      metadata: "",
    };
    let totalSize = 0;

    // Upload trajectories
    const trajData = await fs.readFile(options.trajectoriesPath);
    const trajBlob = await put(`${prefix}trajectories.jsonl`, trajData, {
      access: "public",
      addRandomSuffix: false,
    });
    urls.trajectories = trajBlob.url;
    totalSize += trajData.length;

    // Upload groups if provided
    if (options.groupsPath) {
      const groupsData = await fs.readFile(options.groupsPath);
      const groupsBlob = await put(`${prefix}groups.jsonl`, groupsData, {
        access: "public",
        addRandomSuffix: false,
      });
      urls.groups = groupsBlob.url;
      totalSize += groupsData.length;
    }

    // Upload RULER scores if provided
    if (options.rulerScoresPath) {
      const scoresData = await fs.readFile(options.rulerScoresPath);
      const scoresBlob = await put(`${prefix}ruler_scores.json`, scoresData, {
        access: "public",
        addRandomSuffix: false,
      });
      urls.rulerScores = scoresBlob.url;
      totalSize += scoresData.length;
    }

    // Upload metadata
    const metadataJson = JSON.stringify(options.metadata || {}, null, 2);
    const metadataBlob = await put(`${prefix}metadata.json`, metadataJson, {
      access: "public",
      addRandomSuffix: false,
    });
    urls.metadata = metadataBlob.url;
    totalSize += Buffer.byteLength(metadataJson, "utf8");

    logger.info("Training data archived", {
      windowId: options.windowId,
      size: totalSize,
    });

    return {
      windowId: options.windowId,
      trajectoryCount: (options.metadata?.trajectoryCount as number) || 0,
      blobUrls: urls,
      archivedAt: new Date(),
      size: totalSize,
    };
  }

  /**
   * Retrieve archived training data
   */
  async getWindowData(windowId: string): Promise<{
    trajectories: string;
    groups?: string;
    rulerScores?: Record<string, JsonValue>;
    metadata: Record<string, JsonValue>;
  } | null> {
    const prefix = `${this.blobPrefix}${windowId}/`;
    const { blobs } = await list({ prefix });

    if (blobs.length === 0) {
      return null;
    }

    interface WindowDataResult {
      trajectories?: string;
      groups?: string;
      rulerScores?: Record<string, JsonValue>;
      metadata?: Record<string, JsonValue>;
    }
    const result: WindowDataResult = {};

    for (const blob of blobs) {
      const response = await fetch(blob.url);
      const filename = path.basename(blob.pathname);

      if (filename === "trajectories.jsonl") {
        result.trajectories = await response.text();
      } else if (filename === "groups.jsonl") {
        result.groups = await response.text();
      } else if (filename === "ruler_scores.json") {
        result.rulerScores = (await response.json()) as Record<
          string,
          JsonValue
        >;
      } else if (filename === "metadata.json") {
        result.metadata = (await response.json()) as Record<string, JsonValue>;
      }
    }

    // Ensure required fields are present
    if (!result.trajectories || !result.metadata) {
      return null;
    }

    return {
      trajectories: result.trajectories,
      groups: result.groups,
      rulerScores: result.rulerScores,
      metadata: result.metadata,
    };
  }

  /**
   * List all archived windows
   */
  async listWindows(): Promise<string[]> {
    const { blobs } = await list({ prefix: this.blobPrefix });

    const windows = new Set<string>();
    for (const blob of blobs) {
      const parts = blob.pathname.split("/");
      if (parts[1]) {
        windows.add(parts[1]);
      }
    }

    return Array.from(windows).sort().reverse();
  }

  /**
   * Delete archived window
   */
  async deleteWindow(windowId: string): Promise<void> {
    const prefix = `${this.blobPrefix}${windowId}/`;
    const { blobs } = await list({ prefix });

    for (const blob of blobs) {
      await del(blob.url);
    }

    logger.info("Deleted archived window", { windowId });
  }
}

// Singleton
export const trainingDataArchiver = new TrainingDataArchiver();
