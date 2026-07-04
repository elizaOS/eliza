/**
 * One-shot migration that uploads local `public/images/{actors,actor-banners,
 * organizations,org-banners}/` files to Vercel Blob, preserving the same path
 * so existing image references keep resolving. Uploads concurrently and skips
 * blobs that already exist. Requires `BLOB_READ_WRITE_TOKEN`.
 */

import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { list, put } from "@vercel/blob";
import { config } from "dotenv";
import { logger } from "./lib/logger.js";

// Load environment variables
config();

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// Paths are relative to the web app's public folder
const webPublicDir = join(process.cwd(), "..", "web", "public");

// Directories to migrate
const IMAGE_DIRS = [
  { source: join(webPublicDir, "images/actors"), blobPrefix: "images/actors" },
  {
    source: join(webPublicDir, "images/actor-banners"),
    blobPrefix: "images/actor-banners",
  },
  {
    source: join(webPublicDir, "images/organizations"),
    blobPrefix: "images/organizations",
  },
  {
    source: join(webPublicDir, "images/org-banners"),
    blobPrefix: "images/org-banners",
  },
  // User uploads (from local development)
  {
    source: join(webPublicDir, "uploads/profiles"),
    blobPrefix: "profiles",
  },
  { source: join(webPublicDir, "uploads/covers"), blobPrefix: "covers" },
  { source: join(webPublicDir, "uploads/posts"), blobPrefix: "posts" },
];

interface UploadJob {
  localPath: string;
  blobPath: string;
  filename: string;
}

interface UploadResult {
  url: string;
  pathname: string;
}

/**
 * Check if a blob already exists at the given path
 */
async function blobExists(pathname: string): Promise<boolean> {
  try {
    // Use list with prefix to check - head() requires the full URL, not pathname
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    return blobs.some((blob) => blob.pathname === pathname);
  } catch {
    return false;
  }
}

/**
 * Upload a single image to Vercel Blob
 */
async function uploadImage(job: UploadJob): Promise<UploadResult> {
  const buffer = await readFile(job.localPath);
  const ext = extname(job.filename).toLowerCase();

  const contentType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".png"
        ? "image/png"
        : ext === ".webp"
          ? "image/webp"
          : "application/octet-stream";

  const blob = await put(job.blobPath, buffer, {
    access: "public",
    contentType,
    addRandomSuffix: false,
  });

  return {
    url: blob.url,
    pathname: blob.pathname,
  };
}

/**
 * Process upload queue with concurrency control
 */
async function processQueue(
  jobs: UploadJob[],
  maxConcurrent = 10,
): Promise<{ uploaded: number; failed: number; skipped: number }> {
  let uploaded = 0;
  let failed = 0;
  let skipped = 0;
  const activeJobs = new Set<Promise<void>>();

  for (const job of jobs) {
    if (activeJobs.size >= maxConcurrent) {
      await Promise.race(activeJobs);
    }

    const jobPromise = (async () => {
      // Check if already exists
      const exists = await blobExists(job.blobPath);
      if (exists) {
        skipped++;
        return;
      }

      await uploadImage(job)
        .then((result) => {
          uploaded++;
          logger.info(`✅ Uploaded ${job.blobPath}`, { url: result.url });
        })
        .catch((error: Error) => {
          failed++;
          logger.error(`❌ Failed ${job.blobPath}`, error);
        });
    })();

    activeJobs.add(jobPromise);
    jobPromise.finally(() => activeJobs.delete(jobPromise));
  }

  await Promise.all(activeJobs);
  return { uploaded, failed, skipped };
}

async function main() {
  logger.info("Starting image migration to Vercel Blob...");

  if (!BLOB_TOKEN) {
    logger.error(
      "Error: BLOB_READ_WRITE_TOKEN not found in environment variables",
    );
    process.exit(1);
  }

  const jobs: UploadJob[] = [];

  // Collect all images to upload
  for (const dir of IMAGE_DIRS) {
    const sourcePath = dir.source;

    let files: string[];
    try {
      files = await readdir(sourcePath);
    } catch {
      logger.warn(`Directory not found: ${sourcePath}`);
      continue;
    }

    const imageFiles = files.filter((f) =>
      [".jpg", ".jpeg", ".png", ".webp"].includes(extname(f).toLowerCase()),
    );

    logger.info(`Found ${imageFiles.length} images in ${dir.source}`);

    for (const filename of imageFiles) {
      jobs.push({
        localPath: join(sourcePath, filename),
        blobPath: `${dir.blobPrefix}/${filename}`,
        filename,
      });
    }
  }

  logger.info(`Total images to process: ${jobs.length}`);

  if (jobs.length === 0) {
    logger.info("No images found to migrate");
    return;
  }

  // Process with concurrency
  logger.info("Starting upload (max 10 concurrent)...");
  const result = await processQueue(jobs, 10);

  logger.info("Migration complete!", {
    uploaded: result.uploaded,
    failed: result.failed,
    skipped: result.skipped,
    total: jobs.length,
  });

  // List what was uploaded for verification
  logger.info("Verifying uploaded images...");
  const { blobs } = await list({ prefix: "images/" });
  logger.info(`Total images in blob storage: ${blobs.length}`);

  if (result.failed > 0) {
    process.exit(1);
  }
}

main();
