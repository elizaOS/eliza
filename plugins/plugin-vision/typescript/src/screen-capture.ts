import { logger } from '@elizaos/core';
import type { ScreenCapture, ScreenTile, VisionConfig } from './types';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';

const execAsync = promisify(exec);

export class ScreenCaptureService {
  private config: VisionConfig;
  private activeTileIndex = 0;
  private lastCapture: ScreenCapture | null = null;

  constructor(config: VisionConfig) {
    this.config = config;
  }

  async getScreenInfo(): Promise<{ width: number; height: number } | null> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // macOS: Use system_profiler
        const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json');
        const data = JSON.parse(stdout);

        if (data.SPDisplaysDataType && data.SPDisplaysDataType[0]) {
          const display = data.SPDisplaysDataType[0];
          const resolution = display._items?.[0]?.native_resolution;
          if (resolution) {
            const match = resolution.match(/(\d+) x (\d+)/);
            if (match) {
              return {
                width: parseInt(match[1], 10),
                height: parseInt(match[2], 10),
              };
            }
          }
        }
      } else if (platform === 'linux') {
        // Linux: Use xrandr
        const { stdout } = await execAsync('xrandr | grep " connected primary"');
        const match = stdout.match(/(\d+)x(\d+)/);
        if (match) {
          return {
            width: parseInt(match[1], 10),
            height: parseInt(match[2], 10),
          };
        }
      } else if (platform === 'win32') {
        // Windows: Use wmic
        const { stdout } = await execAsync(
          'wmic path Win32_VideoController get CurrentHorizontalResolution,CurrentVerticalResolution /value'
        );
        const width = stdout.match(/CurrentHorizontalResolution=(\d+)/)?.[1];
        const height = stdout.match(/CurrentVerticalResolution=(\d+)/)?.[1];
        if (width && height) {
          return {
            width: parseInt(width, 10),
            height: parseInt(height, 10),
          };
        }
      }
    } catch (error) {
      logger.error('[ScreenCapture] Failed to get screen info:', error);
    }

    // Default fallback
    return { width: 1920, height: 1080 };
  }

  async captureScreen(): Promise<ScreenCapture> {
    const tempFile = path.join(process.cwd(), `temp_screen_${Date.now()}.png`);

    try {
      // Capture the screen
      await this.captureScreenToFile(tempFile);

      // Load and process the image
      const imageBuffer = await fs.readFile(tempFile);
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();

      const width = metadata.width || 1920;
      const height = metadata.height || 1080;

      // Create tiles
      const tileSize = this.config.tileSize || 256;
      const tiles: ScreenTile[] = [];

      for (let row = 0; row < Math.ceil(height / tileSize); row++) {
        for (let col = 0; col < Math.ceil(width / tileSize); col++) {
          const x = col * tileSize;
          const y = row * tileSize;
          const tileWidth = Math.min(tileSize, width - x);
          const tileHeight = Math.min(tileSize, height - y);

          tiles.push({
            id: `tile-${row}-${col}`,
            row,
            col,
            x,
            y,
            width: tileWidth,
            height: tileHeight,
          });
        }
      }

      // Process active tile based on order
      if (this.config.tileProcessingOrder === 'priority') {
        // Focus on center tiles first
        const centerRow = Math.floor(tiles.length / 2 / Math.ceil(width / tileSize));
        const centerCol = Math.floor((tiles.length / 2) % Math.ceil(width / tileSize));
        this.activeTileIndex = centerRow * Math.ceil(width / tileSize) + centerCol;
      } else if (this.config.tileProcessingOrder === 'random') {
        this.activeTileIndex = Math.floor(Math.random() * tiles.length);
      } else {
        // Sequential
        this.activeTileIndex = (this.activeTileIndex + 1) % tiles.length;
      }

      // Extract active tile data
      const activeTile = tiles[this.activeTileIndex];
      if (activeTile) {
        try {
          const tileBuffer = await image
            .extract({
              left: activeTile.x,
              top: activeTile.y,
              width: activeTile.width,
              height: activeTile.height,
            })
            .png()
            .toBuffer();

          activeTile.data = tileBuffer;
        } catch (error) {
          logger.error('[ScreenCapture] Failed to extract tile:', error);
        }
      }

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});

      // Create screen capture object
      const capture: ScreenCapture = {
        timestamp: Date.now(),
        width,
        height,
        data: imageBuffer,
        tiles,
      };

      this.lastCapture = capture;
      return capture;
    } catch (error) {
      // Clean up temp file on error
      await fs.unlink(tempFile).catch(() => {});
      throw error;
    }
  }

  private async captureScreenToFile(outputPath: string): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // macOS: Use screencapture
        await execAsync(`screencapture -x "${outputPath}"`);
      } else if (platform === 'linux') {
        // Linux: Use scrot or gnome-screenshot
        try {
          await execAsync(`scrot "${outputPath}"`);
        } catch (_error) {
          // Fallback to gnome-screenshot
          await execAsync(`gnome-screenshot -f "${outputPath}"`);
        }
      } else if (platform === 'win32') {
        // Windows: Use PowerShell
        const script = `
          Add-Type -AssemblyName System.Windows.Forms;
          Add-Type -AssemblyName System.Drawing;
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
          $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height;
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
          $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
          $bitmap.Save('${outputPath.replace(/\\/g, '\\\\')}');
          $graphics.Dispose();
          $bitmap.Dispose();
        `;
        await execAsync(`powershell -Command "${script.replace(/\n/g, ' ')}"`);
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error: any) {
      logger.error('[ScreenCapture] Screen capture failed:', error);

      // Provide helpful error messages
      if (platform === 'linux' && error.message.includes('command not found')) {
        throw new Error('Screen capture tool not found. Install with: sudo apt-get install scrot');
      }
      throw error;
    }
  }

  getActiveTile(): ScreenTile | null {
    if (!this.lastCapture || !this.lastCapture.tiles[this.activeTileIndex]) {
      return null;
    }
    return this.lastCapture.tiles[this.activeTileIndex];
  }

  getAllTiles(): ScreenTile[] {
    return this.lastCapture?.tiles || [];
  }

  getProcessedTiles(): ScreenTile[] {
    return this.lastCapture?.tiles.filter((t) => t.analysis) || [];
  }
}
