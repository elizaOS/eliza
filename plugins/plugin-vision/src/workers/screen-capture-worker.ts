import { parentPort, workerData } from 'worker_threads';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { logger } from './worker-logger';

const execAsync = promisify(exec);

interface WorkerConfig {
  displayIndex?: number;
  captureAllDisplays?: boolean;
  targetFPS?: number;
  sharedBufferSize: number;
}

interface DisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  isPrimary?: boolean;
}

class ScreenCaptureWorker {
  private config: WorkerConfig;
  private sharedBuffer: SharedArrayBuffer;
  private dataView: DataView;
  private atomicState: Int32Array;
  private isRunning = true;
  private frameCount = 0;
  private lastFPSReport = Date.now();
  private displays: DisplayInfo[] = [];
  private currentDisplayIndex = 0;

  // Atomic indices
  private readonly FRAME_ID_INDEX = 0;
  private readonly WRITE_LOCK_INDEX = 1;
  private readonly WIDTH_INDEX = 2;
  private readonly HEIGHT_INDEX = 3;
  private readonly DISPLAY_INDEX = 4;
  private readonly TIMESTAMP_INDEX = 5;
  private readonly DATA_OFFSET = 24; // 6 * 4 bytes for metadata

  constructor(config: WorkerConfig, sharedBuffer: SharedArrayBuffer) {
    this.config = config;
    this.sharedBuffer = sharedBuffer;
    this.dataView = new DataView(sharedBuffer);
    this.atomicState = new Int32Array(sharedBuffer, 0, 6);
  }

  async initialize(): Promise<void> {
    // Get display information
    this.displays = await this.getDisplays();

    if (this.displays.length === 0) {
      throw new Error('No displays found');
    }

    // Set initial display
    if (this.config.displayIndex !== undefined && this.config.displayIndex < this.displays.length) {
      this.currentDisplayIndex = this.config.displayIndex;
    }

    logger.info(`[ScreenCaptureWorker] Initialized with ${this.displays.length} displays`);
    this.displays.forEach((d, i) => {
      logger.info(
        `  Display ${i}: ${d.name} (${d.width}x${d.height}) ${d.isPrimary ? '[PRIMARY]' : ''}`
      );
    });
  }

  private async getDisplays(): Promise<DisplayInfo[]> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // macOS: Use system_profiler
        const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json');
        const data = JSON.parse(stdout);
        const displays: DisplayInfo[] = [];

        if (data.SPDisplaysDataType && data.SPDisplaysDataType[0]) {
          const gpuInfo = data.SPDisplaysDataType[0];
          const items = gpuInfo._items || [];

          items.forEach((item: any, index: number) => {
            const resolution = item.native_resolution;
            if (resolution) {
              const match = resolution.match(/(\d+) x (\d+)/);
              if (match) {
                displays.push({
                  id: `display-${index}`,
                  name: item._name || `Display ${index + 1}`,
                  width: parseInt(match[1], 10),
                  height: parseInt(match[2], 10),
                  x: 0,
                  y: 0,
                  isPrimary: index === 0,
                });
              }
            }
          });
        }

        return displays;
      } else if (platform === 'linux') {
        // Linux: Use xrandr
        const { stdout } = await execAsync('xrandr --query');
        const displays: DisplayInfo[] = [];
        const lines = stdout.split('\n');

        for (const line of lines) {
          if (line.includes(' connected')) {
            const match = line.match(/^(\S+) connected (?:primary )?(\d+)x(\d+)\+(\d+)\+(\d+)/);
            if (match) {
              displays.push({
                id: match[1],
                name: match[1],
                width: parseInt(match[2], 10),
                height: parseInt(match[3], 10),
                x: parseInt(match[4], 10),
                y: parseInt(match[5], 10),
                isPrimary: line.includes('primary'),
              });
            }
          }
        }

        return displays;
      } else if (platform === 'win32') {
        // Windows: Use wmic
        const { stdout } = await execAsync(
          'wmic path Win32_DesktopMonitor get DeviceID,ScreenWidth,ScreenHeight /format:csv'
        );
        const displays: DisplayInfo[] = [];
        const lines = stdout.trim().split('\n').slice(2); // Skip headers

        lines.forEach((line, index) => {
          const parts = line.split(',');
          if (parts.length >= 4) {
            const width = parseInt(parts[2], 10);
            const height = parseInt(parts[3], 10);
            if (!isNaN(width) && !isNaN(height)) {
              displays.push({
                id: parts[1],
                name: parts[1] || `Display ${index + 1}`,
                width,
                height,
                x: 0,
                y: 0,
                isPrimary: index === 0,
              });
            }
          }
        });

        return displays.length > 0
          ? displays
          : [
              {
                id: 'primary',
                name: 'Primary Display',
                width: 1920,
                height: 1080,
                x: 0,
                y: 0,
                isPrimary: true,
              },
            ];
      }
    } catch (error) {
      logger.error('[ScreenCaptureWorker] Failed to get display info:', error);
    }

    // Fallback
    return [
      {
        id: 'default',
        name: 'Default Display',
        width: 1920,
        height: 1080,
        x: 0,
        y: 0,
        isPrimary: true,
      },
    ];
  }

  async run(): Promise<void> {
    await this.initialize();

    logger.info('[ScreenCaptureWorker] Starting capture loop...');

    while (this.isRunning) {
      const startTime = Date.now();

      try {
        await this.captureFrame();
        this.frameCount++;

        // Report FPS every second
        const now = Date.now();
        if (now - this.lastFPSReport >= 1000) {
          const fps = this.frameCount / ((now - this.lastFPSReport) / 1000);
          logger.info(
            `[ScreenCaptureWorker] FPS: ${fps.toFixed(2)}, Display: ${this.currentDisplayIndex}`
          );

          parentPort?.postMessage({
            type: 'fps',
            fps,
            frameCount: this.frameCount,
            displayIndex: this.currentDisplayIndex,
          });

          this.frameCount = 0;
          this.lastFPSReport = now;
        }

        // Cycle through displays if configured
        if (this.config.captureAllDisplays && this.displays.length > 1) {
          this.currentDisplayIndex = (this.currentDisplayIndex + 1) % this.displays.length;
        }

        // Target FPS limiting
        if (this.config.targetFPS) {
          const frameTime = 1000 / this.config.targetFPS;
          const elapsed = Date.now() - startTime;
          if (elapsed < frameTime) {
            await new Promise((resolve) => setTimeout(resolve, frameTime - elapsed));
          }
        }
      } catch (error) {
        logger.error('[ScreenCaptureWorker] Capture error:', error);
        await new Promise((resolve) => setTimeout(resolve, 100)); // Brief pause on error
      }
    }
  }

  private async captureFrame(): Promise<void> {
    const display = this.displays[this.currentDisplayIndex];
    const tempFile = path.join(
      process.cwd(),
      `temp_screen_${Date.now()}_${this.currentDisplayIndex}.png`
    );

    try {
      // Capture the screen
      await this.captureScreenToFile(tempFile, display);

      // Load and process the image
      const imageBuffer = await fs.readFile(tempFile);
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();

      const width = metadata.width || display.width;
      const height = metadata.height || display.height;

      // Convert to raw RGBA for shared buffer
      const rawData = await image.ensureAlpha().raw().toBuffer();

      // Wait for write lock
      while (Atomics.compareExchange(this.atomicState, this.WRITE_LOCK_INDEX, 0, 1) !== 0) {
        // Spin wait - in practice this should be very brief
      }

      try {
        // Write metadata
        Atomics.store(this.atomicState, this.WIDTH_INDEX, width);
        Atomics.store(this.atomicState, this.HEIGHT_INDEX, height);
        Atomics.store(this.atomicState, this.DISPLAY_INDEX, this.currentDisplayIndex);
        Atomics.store(this.atomicState, this.TIMESTAMP_INDEX, Date.now());

        // Write image data
        const maxDataSize = this.sharedBuffer.byteLength - this.DATA_OFFSET;
        const dataSize = Math.min(rawData.length, maxDataSize);

        for (let i = 0; i < dataSize; i++) {
          this.dataView.setUint8(this.DATA_OFFSET + i, rawData[i]);
        }

        // Update frame ID (signals new frame available)
        Atomics.add(this.atomicState, this.FRAME_ID_INDEX, 1);
      } finally {
        // Release write lock
        Atomics.store(this.atomicState, this.WRITE_LOCK_INDEX, 0);
      }

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});
    } catch (error) {
      // Clean up temp file on error
      await fs.unlink(tempFile).catch(() => {});
      throw error;
    }
  }

  private async captureScreenToFile(outputPath: string, display: DisplayInfo): Promise<void> {
    const platform = process.platform;

    try {
      if (platform === 'darwin') {
        // macOS: Use screencapture with display index
        const displayArg = this.currentDisplayIndex > 0 ? `-D ${this.currentDisplayIndex + 1}` : '';
        await execAsync(`screencapture -x ${displayArg} "${outputPath}"`);
      } else if (platform === 'linux') {
        // Linux: Use scrot with geometry for specific display
        if (display.x !== 0 || display.y !== 0) {
          // Multi-monitor setup
          await execAsync(
            `scrot -a ${display.x},${display.y},${display.width},${display.height} "${outputPath}"`
          );
        } else {
          await execAsync(`scrot "${outputPath}"`);
        }
      } else if (platform === 'win32') {
        // Windows: PowerShell script for specific monitor
        const script = `
          Add-Type -AssemblyName System.Windows.Forms;
          Add-Type -AssemblyName System.Drawing;
          $screens = [System.Windows.Forms.Screen]::AllScreens;
          $screen = $screens[${this.currentDisplayIndex}];
          $bounds = $screen.Bounds;
          $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap);
          $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
          $bitmap.Save('${outputPath.replace(/\\/g, '\\\\')}');
          $graphics.Dispose();
          $bitmap.Dispose();
        `;
        await execAsync(`powershell -Command "${script.replace(/\n/g, ' ')}"`);
      }
    } catch (error: any) {
      throw new Error(`Screen capture failed: ${error.message}`);
    }
  }

  stop(): void {
    this.isRunning = false;
  }
}

// Worker entry point
if (parentPort) {
  const { config, sharedBuffer } = workerData;
  const worker = new ScreenCaptureWorker(config, sharedBuffer);

  // Handle messages from main thread
  parentPort.on('message', (msg) => {
    if (msg.type === 'stop') {
      worker.stop();
    }
  });

  // Run the worker
  worker.run().catch((error) => {
    logger.error('[ScreenCaptureWorker] Fatal error:', error);
    parentPort?.postMessage({ type: 'error', error: error.message });
    process.exit(1);
  });
}
