/**
 * Artifact utilities for ElizaOS deployment
 * Handles creating, compressing, and managing project artifacts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { logger } from "@elizaos/core";
import * as tar from "tar";
import ignore from "ignore";

export interface ArtifactOptions {
  projectPath: string;
  outputPath?: string;
  excludePatterns?: string[];
  includeEnv?: boolean;
  deterministic?: boolean;
}

export interface ArtifactResult {
  success: boolean;
  artifactPath?: string;
  checksum?: string;
  size?: number;
  fileCount?: number;
  error?: string;
}

export interface ArtifactMetadata {
  version: string;
  createdAt: string;
  checksum: string;
  files: string[];
  dependencies?: Record<string, string>;
  elizaVersion?: string;
}

/**
 * Default patterns to exclude from artifacts
 */
const DEFAULT_EXCLUDE_PATTERNS = [
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  ".idea",
  "*.log",
  "*.tmp",
  ".DS_Store",
  "Thumbs.db",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  ".nyc_output",
  ".pytest_cache",
  "__pycache__",
  "*.pyc",
  ".env.local",
  ".env.*.local",
  "*.pem",
  "*.key",
  "*.cert",
  ".elizadb",
  "*.sqlite",
  "*.db",
  "docker-compose*.yml",
  "Dockerfile*",
  ".dockerignore",
  "*.tar",
  "*.tar.gz",
  "*.zip",
];

/**
 * Files that should always be included if they exist
 */
const REQUIRED_FILES = [
  "package.json",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".env.example",
  "tsconfig.json",
];

/**
 * Create a deployment artifact from a project directory
 */
export async function createArtifact(
  options: ArtifactOptions,
): Promise<ArtifactResult> {
  try {
    const startTime = Date.now();
    logger.info("📦 Creating deployment artifact...");

    // Validate project path
    if (!fs.existsSync(options.projectPath)) {
      return {
        success: false,
        error: `Project path does not exist: ${options.projectPath}`,
      };
    }

    // Check for package.json
    const packageJsonPath = path.join(options.projectPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return {
        success: false,
        error: "No package.json found in project directory",
      };
    }

    // Parse package.json for metadata
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf-8"),
    );

    // Create output path if not specified
    const outputPath =
      options.outputPath || path.join(options.projectPath, ".eliza", "artifacts");
    fs.mkdirSync(outputPath, { recursive: true });

    // Generate artifact filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const projectName = packageJson.name?.replace(/[@/]/g, "-") || "project";
    const artifactName = `${projectName}-${timestamp}.tar.gz`;
    const artifactPath = path.join(outputPath, artifactName);

    // Get list of files to include
    const files = await getFilesToInclude(options);

    if (files.length === 0) {
      return {
        success: false,
        error: "No files to include in artifact",
      };
    }

    logger.info(`📂 Including ${files.length} files in artifact`);

    // Create tar.gz archive
    await createTarGz(
      options.projectPath,
      files,
      artifactPath,
      options.deterministic,
    );

    // Calculate checksum
    const checksum = await calculateChecksum(artifactPath);

    // Get file size
    const stats = fs.statSync(artifactPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    // Create metadata file
    const metadata: ArtifactMetadata = {
      version: packageJson.version || "0.0.0",
      createdAt: new Date().toISOString(),
      checksum,
      files: files.slice(0, 100), // Limit to first 100 files in metadata
      dependencies: packageJson.dependencies,
      elizaVersion: packageJson.dependencies?.["@elizaos/core"],
    };

    const metadataPath = artifactPath.replace(".tar.gz", ".json");
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`✅ Artifact created: ${artifactPath} (${sizeMB} MB in ${duration}s)`);

    return {
      success: true,
      artifactPath,
      checksum,
      size: stats.size,
      fileCount: files.length,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("Failed to create artifact:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Get list of files to include in the artifact
 */
async function getFilesToInclude(options: ArtifactOptions): Promise<string[]> {
  const files: string[] = [];
  const ig = ignore();

  // Load .gitignore if it exists
  const gitignorePath = path.join(options.projectPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }

  // Add default exclude patterns
  ig.add(DEFAULT_EXCLUDE_PATTERNS);

  // Add custom exclude patterns
  if (options.excludePatterns) {
    ig.add(options.excludePatterns);
  }

  // Special handling for .env files
  if (!options.includeEnv) {
    ig.add([".env", ".env.*"]);
  }

  // Walk directory and collect files
  const walkDir = (dir: string, relativePath = ""): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativePath, entry.name);

      // Skip if ignored
      if (ig.ignores(relPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        // Skip node_modules even if not in gitignore
        if (entry.name === "node_modules") {
          continue;
        }
        walkDir(fullPath, relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  };

  // Start walking from project root
  walkDir(options.projectPath);

  // Ensure required files are included
  for (const requiredFile of REQUIRED_FILES) {
    const filePath = path.join(options.projectPath, requiredFile);
    if (fs.existsSync(filePath) && !files.includes(requiredFile)) {
      files.push(requiredFile);
    }
  }

  // Sort files for deterministic output
  if (options.deterministic) {
    files.sort();
  }

  return files;
}

/**
 * Create a tar.gz archive from a list of files
 */
async function createTarGz(
  basePath: string,
  files: string[],
  outputPath: string,
  deterministic = true,
): Promise<void> {
  const tarOptions: {
    gzip: boolean;
    file: string;
    cwd: string;
    portable?: boolean;
    noMtime?: boolean;
    mtime?: Date;
  } = {
    gzip: true,
    file: outputPath,
    cwd: basePath,
    portable: deterministic, // Ensure consistent UIDs/GIDs
    noMtime: deterministic, // Remove modification times for reproducibility
  };

  // If deterministic, set a fixed mtime
  if (deterministic) {
    tarOptions.mtime = new Date("2000-01-01");
  }

  await tar.create(tarOptions, files);
}

/**
 * Calculate SHA256 checksum of a file
 */
export async function calculateChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Extract an artifact to a directory
 */
export async function extractArtifact(
  artifactPath: string,
  outputDir: string,
): Promise<void> {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}`);
  }

  // Create output directory
  fs.mkdirSync(outputDir, { recursive: true });

  // Extract tar.gz
  await tar.extract({
    file: artifactPath,
    cwd: outputDir,
  });

  logger.info(`✅ Artifact extracted to: ${outputDir}`);
}

/**
 * Validate an artifact's integrity
 */
export async function validateArtifact(
  artifactPath: string,
  expectedChecksum?: string,
): Promise<boolean> {
  if (!fs.existsSync(artifactPath)) {
    logger.error("Artifact not found:", artifactPath);
    return false;
  }

  if (!expectedChecksum) {
    // Try to load metadata file
    const metadataPath = artifactPath.replace(".tar.gz", ".json");
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      expectedChecksum = metadata.checksum;
    }
  }

  if (!expectedChecksum) {
    logger.warn("No checksum provided for validation");
    return true; // Allow if no checksum to validate against
  }

  const actualChecksum = await calculateChecksum(artifactPath);
  const isValid = actualChecksum === expectedChecksum;

  if (!isValid) {
    logger.error("Checksum mismatch!");
    logger.error(`Expected: ${expectedChecksum}`);
    logger.error(`Actual: ${actualChecksum}`);
  }

  return isValid;
}

/**
 * Clean up old artifacts
 */
export async function cleanupArtifacts(
  artifactDir: string,
  keepCount = 5,
): Promise<void> {
  if (!fs.existsSync(artifactDir)) {
    return;
  }

  const artifacts = fs
    .readdirSync(artifactDir)
    .filter((f) => f.endsWith(".tar.gz"))
    .map((f) => ({
      name: f,
      path: path.join(artifactDir, f),
      mtime: fs.statSync(path.join(artifactDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  // Keep the most recent artifacts
  const toDelete = artifacts.slice(keepCount);

  for (const artifact of toDelete) {
    try {
      fs.unlinkSync(artifact.path);
      // Also delete metadata file if it exists
      const metadataPath = artifact.path.replace(".tar.gz", ".json");
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
      }
      logger.debug(`Deleted old artifact: ${artifact.name}`);
    } catch (error) {
      logger.warn(`Failed to delete artifact: ${artifact.name}`);
    }
  }

  if (toDelete.length > 0) {
    logger.info(`🧹 Cleaned up ${toDelete.length} old artifacts`);
  }
}
