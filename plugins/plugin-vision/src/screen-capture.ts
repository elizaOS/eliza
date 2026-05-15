import { exec } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";
import sharp from "sharp";
import {
  DEFAULT_MAX_EDGE,
  DEFAULT_OVERLAP_FRACTION,
  type ScreenTile as TilerScreenTile,
  tileScreenshot,
} from "./screen-tiler";
import type { ScreenCapture, ScreenTile, VisionConfig } from "./types";

const execAsync = promisify(exec);

// `tileSize` in VisionConfig is the legacy fixed-grid edge. The new tiler
// treats it as `maxEdge` — the largest dimension a single tile may have. The
// tiler's defaults are tuned for Qwen3.5-VL; respect the config override only
// when it stays in the model-sweet-spot range.
const MIN_TILER_EDGE = 64;
const SINGLE_DISPLAY_ID = "primary";

/**
 * Project a tiler ScreenTile onto the plugin-vision ScreenTile shape consumed
 * by `service.ts` and `ocr-service.ts`. We carry through `displayId`,
 * `sourceX`, and `sourceY` for absolute-coord reconstruction; `row`/`col` are
 * recovered from the tiler id (`tile-<row>-<col>`).
 */
function toVisionTile(
  tile: TilerScreenTile,
  index: number,
  total: number,
): ScreenTile {
  const { row, col } = parseTilerId(tile.id, index, total);
  return {
    id: tile.id,
    row,
    col,
    x: tile.sourceX,
    y: tile.sourceY,
    width: tile.tileW,
    height: tile.tileH,
    displayId: tile.displayId,
    sourceX: tile.sourceX,
    sourceY: tile.sourceY,
  };
}

const TILER_ID_RE = /^tile-(\d+)-(\d+)$/;

function parseTilerId(
  id: string,
  index: number,
  total: number,
): { row: number; col: number } {
  const match = TILER_ID_RE.exec(id);
  if (match?.[1] && match[2]) {
    return {
      row: Number.parseInt(match[1], 10),
      col: Number.parseInt(match[2], 10),
    };
  }
  // Fall back to a single-row layout when the id format ever drifts.
  const cols = Math.max(1, total);
  return { row: Math.floor(index / cols), col: index % cols };
}

function computeCols(tiles: TilerScreenTile[]): number {
  let maxCol = 0;
  for (const tile of tiles) {
    const match = TILER_ID_RE.exec(tile.id);
    if (match?.[2]) {
      const col = Number.parseInt(match[2], 10);
      if (col > maxCol) maxCol = col;
    }
  }
  return maxCol + 1;
}

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
      if (platform === "darwin") {
        // macOS: Use system_profiler
        const { stdout } = await execAsync(
          "system_profiler SPDisplaysDataType -json",
        );
        const data = JSON.parse(stdout);

        if (data.SPDisplaysDataType?.[0]) {
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
      } else if (platform === "linux") {
        // Linux: Use xrandr
        const { stdout } = await execAsync(
          'xrandr | grep " connected primary"',
        );
        const match = stdout.match(/(\d+)x(\d+)/);
        if (match) {
          return {
            width: parseInt(match[1], 10),
            height: parseInt(match[2], 10),
          };
        }
      } else if (platform === "win32") {
        // Windows: Use wmic
        const { stdout } = await execAsync(
          "wmic path Win32_VideoController get CurrentHorizontalResolution,CurrentVerticalResolution /value",
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
      logger.error("[ScreenCapture] Failed to get screen info:", error);
    }

    // Default fallback
    return { width: 1920, height: 1080 };
  }

  async captureScreen(): Promise<ScreenCapture> {
    const tempFile = path.join(process.cwd(), `temp_screen_${Date.now()}.png`);

    try {
      // Capture the screen
      await this.captureScreenToFile(tempFile);

      // Load and decode the image. The tiler does its own crop/extract so we
      // only need the metadata + raw bytes here.
      const imageBuffer = await fs.readFile(tempFile);
      const metadata = await sharp(imageBuffer).metadata();

      const width = metadata.width || 1920;
      const height = metadata.height || 1080;

      // Hand layout to the overlap-aware tiler. It sizes tiles to the model
      // sweet spot (Qwen3.5-VL) and seams them with overlap so glyphs that
      // straddle a boundary still appear intact in at least one tile.
      const maxEdge = Math.max(MIN_TILER_EDGE, this.config.tileSize ?? DEFAULT_MAX_EDGE);
      const tilerTiles = await tileScreenshot(
        {
          displayId: SINGLE_DISPLAY_ID,
          width,
          height,
          pngBytes: imageBuffer,
        },
        { maxEdge, overlapFraction: DEFAULT_OVERLAP_FRACTION },
      );
      const tiles = tilerTiles.map((tile, index) =>
        toVisionTile(tile, index, tilerTiles.length),
      );

      // Process active tile based on order
      const cols = computeCols(tilerTiles);
      if (this.config.tileProcessingOrder === "priority") {
        // Focus on center tiles first
        const centerRow = Math.floor(tiles.length / 2 / cols);
        const centerCol = Math.floor((tiles.length / 2) % cols);
        this.activeTileIndex = Math.min(
          tiles.length - 1,
          centerRow * cols + centerCol,
        );
      } else if (this.config.tileProcessingOrder === "random") {
        this.activeTileIndex = Math.floor(Math.random() * tiles.length);
      } else {
        // Sequential
        this.activeTileIndex = (this.activeTileIndex + 1) % tiles.length;
      }

      // Tiler already produced a PNG buffer for every tile — wire the chosen
      // one into the active slot for downstream OCR / VLM consumption.
      const activeTile = tiles[this.activeTileIndex];
      const activeTilerTile = tilerTiles[this.activeTileIndex];
      if (activeTile && activeTilerTile) {
        activeTile.data = activeTilerTile.pngBytes;
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
      if (platform === "darwin") {
        // macOS: Use screencapture
        await execAsync(`screencapture -x "${outputPath}"`);
      } else if (platform === "linux") {
        // Linux: Use scrot or gnome-screenshot
        try {
          await execAsync(`scrot "${outputPath}"`);
        } catch (_error) {
          // Fallback to gnome-screenshot
          await execAsync(`gnome-screenshot -f "${outputPath}"`);
        }
      } else if (platform === "win32") {
        // Windows: Use PowerShell
        const script = `
          Add-Type -AssemblyName System.Windows.Forms;
          Add-Type -AssemblyName System.Drawing;
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
          $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height;
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
          $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
          $bitmap.Save('${outputPath.replace(/\\/g, "\\\\")}');
          $graphics.Dispose();
          $bitmap.Dispose();
        `;
        await execAsync(`powershell -Command "${script.replace(/\n/g, " ")}"`);
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    } catch (error) {
      logger.error("[ScreenCapture] Screen capture failed:", error);

      // Provide helpful error messages
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (platform === "linux" && errorMessage.includes("command not found")) {
        throw new Error(
          "Screen capture tool not found. Install with: sudo apt-get install scrot",
        );
      }
      throw error;
    }
  }

  getActiveTile(): ScreenTile | null {
    if (!this.lastCapture?.tiles[this.activeTileIndex]) {
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
