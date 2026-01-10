import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { logger } from '@elizaos/core';
import type { ModelSpec } from '../types';

/**
 * Class representing a Download Manager.
 */
export class DownloadManager {
  private static instance: DownloadManager | null = null;
  private cacheDir: string;
  private modelsDir: string;
  // Track active downloads to prevent duplicates
  private activeDownloads: Map<string, Promise<void>> = new Map();

  /**
   * Creates a new instance of CacheManager.
   *
   * @param {string} cacheDir - The directory path for caching data.
   * @param {string} modelsDir - The directory path for model files.
   */
  private constructor(cacheDir: string, modelsDir: string) {
    this.cacheDir = cacheDir;
    this.modelsDir = modelsDir;
    this.ensureCacheDirectory();
    this.ensureModelsDirectory();
  }

  /**
   * Returns the singleton instance of the DownloadManager class.
   * If an instance does not already exist, it creates a new one using the provided cache directory and models directory.
   *
   * @param {string} cacheDir - The directory where downloaded files are stored.
   * @param {string} modelsDir - The directory where model files are stored.
   * @returns {DownloadManager} The singleton instance of the DownloadManager class.
   */
  public static getInstance(cacheDir: string, modelsDir: string): DownloadManager {
    if (!DownloadManager.instance) {
      DownloadManager.instance = new DownloadManager(cacheDir, modelsDir);
    }
    return DownloadManager.instance;
  }

  /**
   * Ensure that the cache directory exists.
   */
  private ensureCacheDirectory(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.debug('Created cache directory');
    }
  }

  /**
   * Ensure that the models directory exists. If it does not exist, create it.
   */
  private ensureModelsDirectory(): void {
    logger.debug('Ensuring models directory exists:', this.modelsDir);
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      logger.debug('Created models directory');
    }
  }

  /**
   * Downloads a file from a given URL to a specified destination path asynchronously.
   *
   * @param {string} url - The URL from which to download the file.
   * @param {string} destPath - The destination path where the downloaded file will be saved.
   * @returns {Promise<void>} A Promise that resolves when the file download is completed successfully or rejects if an error occurs.
   */
  private async downloadFileInternal(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info(`Starting download to: ${destPath}`);

      // Create a temporary file path in the same directory as destPath
      const tempPath = `${destPath}.tmp`;

      // Check if temp file already exists and remove it to avoid conflicts
      if (fs.existsSync(tempPath)) {
        try {
          logger.warn(`Removing existing temporary file: ${tempPath}`);
          fs.unlinkSync(tempPath);
        } catch (err) {
          logger.error(
            `Failed to remove existing temporary file: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      const request = https.get(
        url,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          },
          timeout: 300000, // Increase timeout to 5 minutes
        },
        (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            if (!redirectUrl) {
              reject(new Error('Redirect location not found'));
              return;
            }
            // logger.info(`Following redirect to: ${redirectUrl}`);
            // Remove the current download from tracking before starting a new one
            this.activeDownloads.delete(destPath);
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download: ${response.statusCode}`));
            return;
          }

          const totalSize = Number.parseInt(response.headers['content-length'] || '0', 10);
          let downloadedSize = 0;
          let lastLoggedPercent = 0;
          const barLength = 30;

          // Log initial progress bar
          const fileName = path.basename(destPath);
          logger.info(`Downloading ${fileName}: ${'▱'.repeat(barLength)} 0%`);

          const file = fs.createWriteStream(tempPath);

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const percent = Math.round((downloadedSize / totalSize) * 100);

            // Only update progress bar when percentage changes significantly (every 5%)
            if (percent >= lastLoggedPercent + 5) {
              const filledLength = Math.floor((downloadedSize / totalSize) * barLength);
              const progressBar = '▰'.repeat(filledLength) + '▱'.repeat(barLength - filledLength);
              logger.info(`Downloading ${fileName}: ${progressBar} ${percent}%`);
              lastLoggedPercent = percent;
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close(() => {
              try {
                // Show completed progress bar
                const completedBar = '▰'.repeat(barLength);
                logger.info(`Downloading ${fileName}: ${completedBar} 100%`);

                // Ensure the destination directory exists
                const destDir = path.dirname(destPath);
                if (!fs.existsSync(destDir)) {
                  fs.mkdirSync(destDir, { recursive: true });
                }

                // Check if temp file exists before proceeding
                if (!fs.existsSync(tempPath)) {
                  reject(new Error(`Temporary file ${tempPath} does not exist`));
                  return;
                }

                // Only delete the existing file if the temp file is ready
                if (fs.existsSync(destPath)) {
                  try {
                    // Create a backup of the existing file before deleting it
                    const backupPath = `${destPath}.bak`;
                    fs.renameSync(destPath, backupPath);
                    logger.info(`Created backup of existing file: ${backupPath}`);

                    // Move temp file to destination
                    fs.renameSync(tempPath, destPath);

                    // If successful, remove the backup
                    if (fs.existsSync(backupPath)) {
                      fs.unlinkSync(backupPath);
                      logger.info(`Removed backup file after successful update: ${backupPath}`);
                    }
                  } catch (moveErr) {
                    logger.error(
                      `Error replacing file: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`
                    );

                    // Try to restore from backup if the move failed
                    const backupPath = `${destPath}.bak`;
                    if (fs.existsSync(backupPath)) {
                      try {
                        fs.renameSync(backupPath, destPath);
                        logger.info(`Restored from backup after failed update: ${backupPath}`);
                      } catch (restoreErr) {
                        logger.error(
                          `Failed to restore from backup: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`
                        );
                      }
                    }

                    // Clean up temp file
                    if (fs.existsSync(tempPath)) {
                      try {
                        fs.unlinkSync(tempPath);
                      } catch (unlinkErr) {
                        logger.error(
                          `Failed to clean up temp file: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
                        );
                      }
                    }

                    reject(moveErr);
                    return;
                  }
                } else {
                  // No existing file, just move the temp file
                  fs.renameSync(tempPath, destPath);
                }

                logger.success(`Download of ${fileName} completed successfully`);

                // Remove from active downloads
                this.activeDownloads.delete(destPath);
                resolve();
              } catch (err) {
                logger.error(
                  `Error finalizing download: ${err instanceof Error ? err.message : String(err)}`
                );
                // Clean up temp file if it exists
                if (fs.existsSync(tempPath)) {
                  try {
                    fs.unlinkSync(tempPath);
                  } catch (unlinkErr) {
                    logger.error(
                      `Failed to clean up temp file: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
                    );
                  }
                }
                // Remove from active downloads
                this.activeDownloads.delete(destPath);
                reject(err);
              }
            });
          });

          file.on('error', (err) => {
            logger.error(`File write error: ${err instanceof Error ? err.message : String(err)}`);
            file.close(() => {
              if (fs.existsSync(tempPath)) {
                try {
                  fs.unlinkSync(tempPath);
                } catch (unlinkErr) {
                  logger.error(
                    `Failed to clean up temp file after error: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
                  );
                }
              }
              // Remove from active downloads
              this.activeDownloads.delete(destPath);
              reject(err);
            });
          });
        }
      );

      request.on('error', (err) => {
        logger.error(`Request error: ${err instanceof Error ? err.message : String(err)}`);
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (unlinkErr) {
            logger.error(
              `Failed to clean up temp file after request error: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
            );
          }
        }
        // Remove from active downloads
        this.activeDownloads.delete(destPath);
        reject(err);
      });

      request.on('timeout', () => {
        logger.error('Download timeout occurred');
        request.destroy();
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (unlinkErr) {
            logger.error(
              `Failed to clean up temp file after timeout: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
            );
          }
        }
        // Remove from active downloads
        this.activeDownloads.delete(destPath);
        reject(new Error('Download timeout'));
      });
    });
  }

  /**
   * Asynchronously downloads a file from the specified URL to the destination path.
   *
   * @param {string} url - The URL of the file to download.
   * @param {string} destPath - The destination path to save the downloaded file.
   * @returns {Promise<void>} A Promise that resolves once the file has been successfully downloaded.
   */
  public async downloadFile(url: string, destPath: string): Promise<void> {
    // Check if this file is already being downloaded
    if (this.activeDownloads.has(destPath)) {
      logger.info(`Download for ${destPath} already in progress, waiting for it to complete...`);
      const existingDownload = this.activeDownloads.get(destPath);
      if (existingDownload) {
        return existingDownload;
      }
      // If somehow the download was removed from the map but the key still exists
      logger.warn(
        `Download for ${destPath} was marked as in progress but not found in tracking map`
      );
    }

    // Start a new download and track it
    const downloadPromise = this.downloadFileInternal(url, destPath);
    this.activeDownloads.set(destPath, downloadPromise);

    try {
      return await downloadPromise;
    } catch (error) {
      // Make sure to remove from active downloads in case of error
      this.activeDownloads.delete(destPath);
      throw error;
    }
  }

  /**
   * Downloads a model specified by the modelSpec and saves it to the provided modelPath.
   * If the model is successfully downloaded, returns true, otherwise returns false.
   *
   * @param {ModelSpec} modelSpec - The model specification containing repo and name.
   * @param {string} modelPath - The path where the model will be saved.
   * @returns {Promise<boolean>} - Indicates if the model was successfully downloaded or not.
   */
  public async downloadModel(modelSpec: ModelSpec, modelPath: string): Promise<boolean> {
    try {
      logger.info('Starting local model download...');

      // Ensure model directory exists
      const modelDir = path.dirname(modelPath);
      if (!fs.existsSync(modelDir)) {
        logger.info('Creating model directory:', modelDir);
        fs.mkdirSync(modelDir, { recursive: true });
      }

      if (!fs.existsSync(modelPath)) {
        // Try different URL patterns in sequence, similar to TTS manager approach
        const attempts = [
          {
            description: 'LFS URL with GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name}?download=true`,
          },
          {
            description: 'LFS URL without GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo.replace('-GGUF', '')}/resolve/main/${modelSpec.name}?download=true`,
          },
          {
            description: 'Standard URL with GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo}/resolve/main/${modelSpec.name}`,
          },
          {
            description: 'Standard URL without GGUF suffix',
            url: `https://huggingface.co/${modelSpec.repo.replace('-GGUF', '')}/resolve/main/${modelSpec.name}`,
          },
        ];

        // logger.info("Model download details:", {
        //   modelName: modelSpec.name,
        //   repo: modelSpec.repo,
        //   modelPath: modelPath,
        //   attemptUrls: attempts.map(a => ({ description: a.description, url: a.url })),
        //   timestamp: new Date().toISOString()
        // });

        let lastError = null;
        let downloadSuccess = false;

        for (const attempt of attempts) {
          try {
            logger.info('Attempting model download:', {
              description: attempt.description,
              url: attempt.url,
              timestamp: new Date().toISOString(),
            });

            // The downloadFile method now handles the progress bar display
            await this.downloadFile(attempt.url, modelPath);

            logger.success(
              `Model download complete: ${modelSpec.name} using ${attempt.description}`
            );
            downloadSuccess = true;
            break;
          } catch (error) {
            lastError = error;
            logger.warn('Model download attempt failed:', {
              description: attempt.description,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            });
          }
        }

        if (!downloadSuccess) {
          throw lastError || new Error('All download attempts failed');
        }

        // Return true to indicate the model was newly downloaded
        return true;
      }

      // Model already exists
      logger.info('Model already exists at:', modelPath);
      // Return false to indicate the model already existed
      return false;
    } catch (error) {
      logger.error('Model download failed:', {
        error: error instanceof Error ? error.message : String(error),
        modelPath: modelPath,
        model: modelSpec.name,
      });
      throw error;
    }
  }

  /**
   * Returns the cache directory path.
   *
   * @returns {string} The path of the cache directory.
   */

  public getCacheDir(): string {
    return this.cacheDir;
  }

  /**
   * Downloads a file from a given URL to a specified destination path.
   *
   * @param {string} url - The URL of the file to download.
   * @param {string} destPath - The destination path where the file should be saved.
   * @returns {Promise<void>} A Promise that resolves once the file has been downloaded.
   */
  public async downloadFromUrl(url: string, destPath: string): Promise<void> {
    return this.downloadFile(url, destPath);
  }

  /**
   * Ensures that the specified directory exists. If it does not exist, it will be created.
   * @param {string} dirPath - The path of the directory to ensure existence of.
   * @returns {void}
   */
  public ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.info(`Created directory: ${dirPath}`);
    }
  }
}
