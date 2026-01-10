import { parentPort, workerData } from 'worker_threads';
import { logger } from './worker-logger';
import { OCRService } from '../ocr-service';
import type { OCRResult } from '../types';
import sharp from 'sharp';

interface WorkerConfig {
  processFullScreen: boolean;
  tileSize: number;
  textRegions?: Array<{ x: number; y: number; width: number; height: number }>;
}

interface SharedMetadata {
  frameId: number;
  width: number;
  height: number;
  displayIndex: number;
  timestamp: number;
}

class OCRWorker {
  private config: WorkerConfig;
  private sharedBuffer: SharedArrayBuffer;
  private dataView: DataView;
  private atomicState: Int32Array;
  private resultsBuffer: SharedArrayBuffer;
  private resultsView: DataView;
  private ocrService: OCRService;
  private isRunning = true;
  private frameCount = 0;
  private lastFPSReport = Date.now();
  private lastFrameId = -1;

  // Atomic indices for input buffer
  private readonly FRAME_ID_INDEX = 0;
  private readonly WRITE_LOCK_INDEX = 1;
  private readonly WIDTH_INDEX = 2;
  private readonly HEIGHT_INDEX = 3;
  private readonly DISPLAY_INDEX = 4;
  private readonly TIMESTAMP_INDEX = 5;
  private readonly DATA_OFFSET = 24;

  // Results buffer structure
  private readonly RESULTS_HEADER_SIZE = 16;
  private readonly MAX_TEXT_LENGTH = 65536; // 64KB for text

  constructor(
    config: WorkerConfig,
    sharedBuffer: SharedArrayBuffer,
    resultsBuffer: SharedArrayBuffer
  ) {
    this.config = config;
    this.sharedBuffer = sharedBuffer;
    this.dataView = new DataView(sharedBuffer);
    this.atomicState = new Int32Array(sharedBuffer, 0, 6);
    this.resultsBuffer = resultsBuffer;
    this.resultsView = new DataView(resultsBuffer);
    this.ocrService = new OCRService();
  }

  async initialize(): Promise<void> {
    await this.ocrService.initialize();
    logger.info('[OCRWorker] Initialized and ready');
  }

  async run(): Promise<void> {
    await this.initialize();

    logger.info('[OCRWorker] Starting OCR loop...');

    while (this.isRunning) {
      try {
        // Check for new frame
        const currentFrameId = Atomics.load(this.atomicState, this.FRAME_ID_INDEX);

        if (currentFrameId > this.lastFrameId) {
          await this.processFrame();
          this.lastFrameId = currentFrameId;
          this.frameCount++;

          // Report FPS
          const now = Date.now();
          if (now - this.lastFPSReport >= 1000) {
            const fps = this.frameCount / ((now - this.lastFPSReport) / 1000);
            logger.info(`[OCRWorker] OCR FPS: ${fps.toFixed(2)}`);

            parentPort?.postMessage({
              type: 'fps',
              fps,
              frameCount: this.frameCount,
            });

            this.frameCount = 0;
            this.lastFPSReport = now;
          }
        } else {
          // No new frame, brief yield
          await new Promise((resolve) => setImmediate(resolve));
        }
      } catch (error) {
        logger.error('[OCRWorker] Processing error:', error);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private async processFrame(): Promise<void> {
    // Read metadata atomically
    const metadata: SharedMetadata = {
      frameId: Atomics.load(this.atomicState, this.FRAME_ID_INDEX),
      width: Atomics.load(this.atomicState, this.WIDTH_INDEX),
      height: Atomics.load(this.atomicState, this.HEIGHT_INDEX),
      displayIndex: Atomics.load(this.atomicState, this.DISPLAY_INDEX),
      timestamp: Atomics.load(this.atomicState, this.TIMESTAMP_INDEX),
    };

    const results: OCRResult[] = [];

    if (this.config.processFullScreen) {
      // Process entire screen
      try {
        const screenBuffer = await this.extractFullScreenBuffer(metadata);
        const ocrResult = await this.ocrService.extractText(screenBuffer);
        results.push(ocrResult);

        logger.debug(`[OCRWorker] Full screen OCR: ${ocrResult.fullText.length} chars`);
      } catch (error) {
        logger.error('[OCRWorker] Full screen OCR failed:', error);
      }
    }

    // Process specific text regions if defined
    if (this.config.textRegions && this.config.textRegions.length > 0) {
      for (const region of this.config.textRegions) {
        try {
          const regionBuffer = await this.extractRegionBuffer(region, metadata);
          const ocrResult = await this.ocrService.extractText(regionBuffer);
          results.push(ocrResult);

          logger.debug(
            `[OCRWorker] Region OCR (${region.x},${region.y}): ${ocrResult.fullText.length} chars`
          );
        } catch (error) {
          logger.error('[OCRWorker] Region OCR failed:', error);
        }
      }
    }

    // Write combined results to buffer
    await this.writeResultsToBuffer(results, metadata.frameId);

    // Notify main thread
    const totalText = results.map((r) => r.fullText).join('\n');
    const totalBlocks = results.reduce((sum, r) => sum + r.blocks.length, 0);

    parentPort?.postMessage({
      type: 'ocr_complete',
      frameId: metadata.frameId,
      displayIndex: metadata.displayIndex,
      textLength: totalText.length,
      blockCount: totalBlocks,
      hasText: totalText.length > 0,
    });
  }

  private async extractFullScreenBuffer(metadata: SharedMetadata): Promise<Buffer> {
    const bytesPerPixel = 4; // RGBA
    const totalPixels = metadata.width * metadata.height;
    const totalBytes = totalPixels * bytesPerPixel;

    // Create buffer for full screen
    const screenData = Buffer.allocUnsafe(totalBytes);

    // Copy all data
    for (let i = 0; i < totalBytes; i++) {
      screenData[i] = this.dataView.getUint8(this.DATA_OFFSET + i);
    }

    // Convert to PNG for OCR
    const pngBuffer = await sharp(screenData, {
      raw: {
        width: metadata.width,
        height: metadata.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();

    return pngBuffer;
  }

  private async extractRegionBuffer(
    region: { x: number; y: number; width: number; height: number },
    metadata: SharedMetadata
  ): Promise<Buffer> {
    const bytesPerPixel = 4; // RGBA
    const rowStride = metadata.width * bytesPerPixel;

    // Clamp region to screen bounds
    const x = Math.max(0, Math.min(region.x, metadata.width - 1));
    const y = Math.max(0, Math.min(region.y, metadata.height - 1));
    const width = Math.min(region.width, metadata.width - x);
    const height = Math.min(region.height, metadata.height - y);

    // Create buffer for region
    const regionData = Buffer.allocUnsafe(width * height * bytesPerPixel);

    // Copy region data row by row
    for (let row = 0; row < height; row++) {
      const sourceY = y + row;
      const sourceOffset = this.DATA_OFFSET + sourceY * rowStride + x * bytesPerPixel;
      const destOffset = row * width * bytesPerPixel;

      for (let i = 0; i < width * bytesPerPixel; i++) {
        regionData[destOffset + i] = this.dataView.getUint8(sourceOffset + i);
      }
    }

    // Convert to PNG for OCR
    const pngBuffer = await sharp(regionData, {
      raw: {
        width,
        height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();

    return pngBuffer;
  }

  private async writeResultsToBuffer(results: OCRResult[], frameId: number): Promise<void> {
    // Combine all results
    const combinedResult = {
      frameId,
      timestamp: Date.now(),
      fullText: results.map((r) => r.fullText).join('\n'),
      blocks: results.flatMap((r) => r.blocks),
      regions: results.length,
    };

    const resultJson = JSON.stringify(combinedResult);
    const resultBytes = Buffer.from(resultJson, 'utf-8');

    // Write to results buffer
    const offset = this.RESULTS_HEADER_SIZE;

    // Write length
    this.resultsView.setUint32(offset, resultBytes.length, true);

    // Write frame ID
    this.resultsView.setUint32(offset + 4, frameId, true);

    // Write timestamp
    this.resultsView.setFloat64(offset + 8, Date.now(), true);

    // Write text data
    const dataOffset = offset + 16;
    for (let i = 0; i < Math.min(resultBytes.length, this.MAX_TEXT_LENGTH); i++) {
      this.resultsView.setUint8(dataOffset + i, resultBytes[i]);
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  async dispose(): Promise<void> {
    await this.ocrService.dispose();
  }

  updateTextRegions(regions: Array<{ x: number; y: number; width: number; height: number }>): void {
    this.config.textRegions = regions;
  }
}

// Worker entry point
if (parentPort) {
  const { config, sharedBuffer, resultsBuffer } = workerData;
  const worker = new OCRWorker(config, sharedBuffer, resultsBuffer);

  // Handle messages from main thread
  parentPort.on('message', (msg) => {
    if (msg.type === 'stop') {
      worker.stop();
      worker.dispose().then(() => {
        parentPort?.postMessage({ type: 'stopped' });
      });
    } else if (msg.type === 'update_regions') {
      worker.updateTextRegions(msg.regions);
    }
  });

  // Run the worker
  worker.run().catch((error) => {
    logger.error('[OCRWorker] Fatal error:', error);
    parentPort?.postMessage({ type: 'error', error: error.message });
    process.exit(1);
  });
}
