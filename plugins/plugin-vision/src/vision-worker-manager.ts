import { Worker } from 'worker_threads';
import * as path from 'path';
import { TextDecoder } from 'util';
import { logger } from '@elizaos/core';
import type {
  VisionConfig,
  ScreenCapture,
  Florence2Result,
  OCRResult,
  EnhancedSceneDescription,
} from './types';

interface WorkerStats {
  fps: number;
  frameCount: number;
  lastUpdate: number;
}

export class VisionWorkerManager {
  private config: VisionConfig;

  // Workers
  private screenCaptureWorker: Worker | null = null;
  private florence2Worker: Worker | null = null;
  private ocrWorker: Worker | null = null;

  // Shared buffers
  private screenBuffer: SharedArrayBuffer;
  private florence2ResultsBuffer: SharedArrayBuffer;
  private ocrResultsBuffer: SharedArrayBuffer;

  // Buffer views
  private screenAtomicState: Int32Array;
  private screenDataView: DataView;
  private florence2ResultsView: DataView;
  private ocrResultsView: DataView;

  // Buffer sizes
  private readonly SCREEN_BUFFER_SIZE = 50 * 1024 * 1024; // 50MB for 4K screen
  private readonly FLORENCE2_RESULTS_SIZE = 10 * 1024 * 1024; // 10MB for results
  private readonly OCR_RESULTS_SIZE = 5 * 1024 * 1024; // 5MB for OCR text

  // Atomic indices
  private readonly FRAME_ID_INDEX = 0;
  private readonly WIDTH_INDEX = 2;
  private readonly HEIGHT_INDEX = 3;
  private readonly DISPLAY_INDEX = 4;
  private readonly TIMESTAMP_INDEX = 5;
  private readonly DATA_OFFSET = 24;

  // Worker stats
  private workerStats = new Map<string, WorkerStats>();

  // Latest processed data cache
  private latestScreenCapture: ScreenCapture | null = null;
  private latestFlorence2Results = new Map<string, Florence2Result>();
  private latestOCRResult: OCRResult | null = null;
  private lastProcessedFrameId = -1;

  // Worker restart tracking
  private restartAttempts = new Map<string, number>();
  private readonly MAX_RESTART_ATTEMPTS = 3;

  constructor(config: VisionConfig) {
    this.config = config;

    // Initialize shared buffers
    this.screenBuffer = new SharedArrayBuffer(this.SCREEN_BUFFER_SIZE);
    this.florence2ResultsBuffer = new SharedArrayBuffer(this.FLORENCE2_RESULTS_SIZE);
    this.ocrResultsBuffer = new SharedArrayBuffer(this.OCR_RESULTS_SIZE);

    // Create views
    this.screenAtomicState = new Int32Array(this.screenBuffer, 0, 6);
    this.screenDataView = new DataView(this.screenBuffer);
    this.florence2ResultsView = new DataView(this.florence2ResultsBuffer);
    this.ocrResultsView = new DataView(this.ocrResultsBuffer);
  }

  async initialize(): Promise<void> {
    logger.info('[VisionWorkerManager] Initializing worker threads...');

    try {
      // Start screen capture worker
      await this.startScreenCaptureWorker();

      // Start Florence-2 worker if enabled
      if (this.config.florence2Enabled) {
        await this.startFlorence2Worker();
      }

      // Start OCR worker if enabled
      if (this.config.ocrEnabled) {
        await this.startOCRWorker();
      }

      logger.info('[VisionWorkerManager] All workers initialized');
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to initialize workers:', error);
      throw error;
    }
  }

  private async startScreenCaptureWorker(): Promise<void> {
    const workerPath = path.join(__dirname, 'workers', 'screen-capture-worker.js');

    this.screenCaptureWorker = new Worker(workerPath, {
      workerData: {
        config: {
          displayIndex: this.config.displayIndex,
          captureAllDisplays: this.config.captureAllDisplays,
          targetFPS: this.config.targetScreenFPS,
          sharedBufferSize: this.SCREEN_BUFFER_SIZE,
        },
        sharedBuffer: this.screenBuffer,
      },
    });

    this.screenCaptureWorker.on('message', (msg) => {
      if (msg.type === 'fps') {
        this.workerStats.set('screenCapture', {
          fps: msg.fps,
          frameCount: msg.frameCount,
          lastUpdate: Date.now(),
        });
      } else if (msg.type === 'error') {
        logger.error('[ScreenCaptureWorker] Error:', msg.error);
      } else if (msg.type === 'log') {
        // Handle worker log messages
        this.handleWorkerLog('ScreenCaptureWorker', msg);
      }
    });

    this.screenCaptureWorker.on('error', (error) => {
      logger.error('[ScreenCaptureWorker] Worker error:', error);
      // Attempt to restart worker after error
      setTimeout(() => this.restartScreenCaptureWorker(), 1000);
    });

    this.screenCaptureWorker.on('exit', (code) => {
      if (code !== 0) {
        logger.error(`[ScreenCaptureWorker] Worker stopped with exit code ${code}`);
        // Attempt to restart worker after crash
        setTimeout(() => this.restartScreenCaptureWorker(), 1000);
      }
    });
  }

  private async startFlorence2Worker(): Promise<void> {
    const workerPath = path.join(__dirname, 'workers', 'florence2-worker.js');

    // Calculate priority tiles (center tiles)
    const priorityTiles: number[] = [];
    const tileSize = this.config.tileSize || 256;
    const estimatedCols = Math.ceil(1920 / tileSize); // Estimate based on common resolution
    const centerRow = Math.floor(estimatedCols / 2);
    const centerCol = Math.floor(estimatedCols / 2);

    // Add center and adjacent tiles as priority
    for (let r = centerRow - 1; r <= centerRow + 1; r++) {
      for (let c = centerCol - 1; c <= centerCol + 1; c++) {
        if (r >= 0 && c >= 0) {
          priorityTiles.push(r * estimatedCols + c);
        }
      }
    }

    this.florence2Worker = new Worker(workerPath, {
      workerData: {
        config: {
          tileSize: this.config.tileSize || 256,
          priorityTiles,
        },
        sharedBuffer: this.screenBuffer,
        resultsBuffer: this.florence2ResultsBuffer,
      },
    });

    this.florence2Worker.on('message', (msg) => {
      if (msg.type === 'fps') {
        this.workerStats.set('florence2', {
          fps: msg.fps,
          frameCount: msg.frameCount,
          lastUpdate: Date.now(),
        });
      } else if (msg.type === 'tile_analyzed') {
        // Update latest results cache
        this.updateFlorence2Cache(msg);
      } else if (msg.type === 'error') {
        logger.error('[Florence2Worker] Error:', msg.error);
      } else if (msg.type === 'log') {
        // Handle worker log messages
        this.handleWorkerLog('Florence2Worker', msg);
      }
    });

    this.florence2Worker.on('error', (error) => {
      logger.error('[Florence2Worker] Worker error:', error);
      // Attempt to restart worker after error
      setTimeout(() => this.restartFlorence2Worker(), 1000);
    });

    this.florence2Worker.on('exit', (code) => {
      if (code !== 0) {
        logger.error(`[Florence2Worker] Worker stopped with exit code ${code}`);
        // Attempt to restart worker after crash
        setTimeout(() => this.restartFlorence2Worker(), 1000);
      }
    });
  }

  private async startOCRWorker(): Promise<void> {
    const workerPath = path.join(__dirname, 'workers', 'ocr-worker.js');

    this.ocrWorker = new Worker(workerPath, {
      workerData: {
        config: {
          processFullScreen: true,
          tileSize: this.config.tileSize || 256,
          textRegions: this.config.textRegions,
        },
        sharedBuffer: this.screenBuffer,
        resultsBuffer: this.ocrResultsBuffer,
      },
    });

    this.ocrWorker.on('message', (msg) => {
      if (msg.type === 'fps') {
        this.workerStats.set('ocr', {
          fps: msg.fps,
          frameCount: msg.frameCount,
          lastUpdate: Date.now(),
        });
      } else if (msg.type === 'ocr_complete') {
        // Update latest OCR cache
        this.updateOCRCache(msg);
      } else if (msg.type === 'error') {
        logger.error('[OCRWorker] Error:', msg.error);
      } else if (msg.type === 'log') {
        // Handle worker log messages
        this.handleWorkerLog('OCRWorker', msg);
      }
    });

    this.ocrWorker.on('error', (error) => {
      logger.error('[OCRWorker] Worker error:', error);
      // Attempt to restart worker after error
      setTimeout(() => this.restartOCRWorker(), 1000);
    });

    this.ocrWorker.on('exit', (code) => {
      if (code !== 0) {
        logger.error(`[OCRWorker] Worker stopped with exit code ${code}`);
        // Attempt to restart worker after crash
        setTimeout(() => this.restartOCRWorker(), 1000);
      }
    });
  }

  private updateFlorence2Cache(msg: any): void {
    // Read result from shared buffer
    try {
      const tileId = msg.tileId;
      const result = this.readFlorence2Result(tileId);
      if (result) {
        this.latestFlorence2Results.set(tileId, result);
      }
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to update Florence2 cache:', error);
    }
  }

  private updateOCRCache(_msg: any): void {
    // Read OCR result from shared buffer
    try {
      const result = this.readOCRResult();
      if (result) {
        this.latestOCRResult = result;
      }
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to update OCR cache:', error);
    }
  }

  private readFlorence2Result(tileId: string): Florence2Result | null {
    try {
      // Calculate tile index from ID
      const match = tileId.match(/tile-(\d+)-(\d+)/);
      if (!match) {
        return null;
      }

      const row = parseInt(match[1], 10);
      const col = parseInt(match[2], 10);
      const tileIndex = row * 10 + col; // Assuming max 10 columns

      const RESULTS_HEADER_SIZE = 16;
      const MAX_RESULT_SIZE = 4096;
      const offset = RESULTS_HEADER_SIZE + tileIndex * MAX_RESULT_SIZE;

      // Read length
      const length = this.florence2ResultsView.getUint32(offset, true);
      if (length === 0 || length > MAX_RESULT_SIZE - 4) {
        return null;
      }

      // Read JSON data
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = this.florence2ResultsView.getUint8(offset + 4 + i);
      }

      const json = new TextDecoder().decode(bytes);
      return JSON.parse(json);
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to read Florence2 result:', error);
      return null;
    }
  }

  private readOCRResult(): OCRResult | null {
    try {
      const RESULTS_HEADER_SIZE = 16;
      const offset = RESULTS_HEADER_SIZE;

      // Read length
      const length = this.ocrResultsView.getUint32(offset, true);
      if (length === 0) {
        return null;
      }

      // Read frame ID and timestamp
      const _frameId = this.ocrResultsView.getUint32(offset + 4, true);
      const _timestamp = this.ocrResultsView.getFloat64(offset + 8, true);

      // Read JSON data
      const dataOffset = offset + 16;
      const bytes = new Uint8Array(Math.min(length, 65536));
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = this.ocrResultsView.getUint8(dataOffset + i);
      }

      const json = new TextDecoder().decode(bytes);
      return JSON.parse(json);
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to read OCR result:', error);
      return null;
    }
  }

  // Public API - Non-blocking access to latest data

  getLatestScreenCapture(): ScreenCapture | null {
    // Read current frame metadata
    const frameId = Atomics.load(this.screenAtomicState, this.FRAME_ID_INDEX);

    if (frameId <= this.lastProcessedFrameId) {
      return this.latestScreenCapture;
    }

    try {
      const width = Atomics.load(this.screenAtomicState, this.WIDTH_INDEX);
      const height = Atomics.load(this.screenAtomicState, this.HEIGHT_INDEX);
      const _displayIndex = Atomics.load(this.screenAtomicState, this.DISPLAY_INDEX);
      const timestamp = Atomics.load(this.screenAtomicState, this.TIMESTAMP_INDEX);

      // Create screen capture object
      this.latestScreenCapture = {
        timestamp,
        width,
        height,
        data: Buffer.alloc(0), // We don't copy the full data for performance
        tiles: this.generateTiles(width, height),
      };

      this.lastProcessedFrameId = frameId;
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to read screen capture:', error);
    }

    return this.latestScreenCapture;
  }

  getLatestEnhancedScene(): EnhancedSceneDescription {
    const screenCapture = this.getLatestScreenCapture();

    // Combine all Florence-2 results
    const florence2Captions: string[] = [];
    const allObjects: any[] = [];
    const allTags = new Set<string>();

    this.latestFlorence2Results.forEach((result) => {
      if (result.caption) {
        florence2Captions.push(result.caption);
      }
      if (result.objects) {
        allObjects.push(...result.objects);
      }
      if (result.tags) {
        result.tags.forEach((tag) => allTags.add(tag));
      }
    });

    const _tiles = this.generateTiles(screenCapture?.width || 0, screenCapture?.height || 0);

    return {
      timestamp: Date.now(),
      description: florence2Captions.join('. '),
      objects: allObjects,
      people: [], // Could be populated by TensorFlow worker
      sceneChanged: true,
      changePercentage: 100,
      screenCapture: this.latestScreenCapture || undefined,
      screenAnalysis: {
        fullScreenOCR: this.latestOCRResult?.fullText,
        activeTile: {
          timestamp: Date.now(),
          florence2: this.latestFlorence2Results.values().next().value,
          ocr: this.latestOCRResult || undefined,
        },
        gridSummary: `${screenCapture?.tiles.length || 0} tiles analyzed`,
        uiElements: allObjects.map((obj) => ({
          type: obj.label,
          text: '',
          position: obj.bbox,
        })),
      },
    };
  }

  private generateTiles(
    width: number,
    height: number
  ): Array<{
    id: string;
    row: number;
    col: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    const tileSize = this.config.tileSize || 256;
    const tiles: Array<{
      id: string;
      row: number;
      col: number;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    for (let row = 0; row < Math.ceil(height / tileSize); row++) {
      for (let col = 0; col < Math.ceil(width / tileSize); col++) {
        const x = col * tileSize;
        const y = row * tileSize;
        tiles.push({
          id: `tile-${row}-${col}`,
          row,
          col,
          x,
          y,
          width: Math.min(tileSize, width - x),
          height: Math.min(tileSize, height - y),
        });
      }
    }

    return tiles;
  }

  getWorkerStats(): Map<string, WorkerStats> {
    return new Map(this.workerStats);
  }

  async setDisplayIndex(index: number): Promise<void> {
    if (this.screenCaptureWorker) {
      this.screenCaptureWorker.postMessage({
        type: 'set_display',
        displayIndex: index,
      });
    }
  }

  async setTextRegions(
    regions: Array<{ x: number; y: number; width: number; height: number }>
  ): Promise<void> {
    if (this.ocrWorker) {
      this.ocrWorker.postMessage({
        type: 'update_regions',
        regions,
      });
    }
  }

  async stop(): Promise<void> {
    logger.info('[VisionWorkerManager] Stopping all workers...');

    const stopPromises: Promise<void>[] = [];

    if (this.screenCaptureWorker) {
      stopPromises.push(
        new Promise((resolve) => {
          this.screenCaptureWorker!.once('exit', () => resolve());
          this.screenCaptureWorker!.postMessage({ type: 'stop' });
        })
      );
    }

    if (this.florence2Worker) {
      stopPromises.push(
        new Promise((resolve) => {
          this.florence2Worker!.once('exit', () => resolve());
          this.florence2Worker!.postMessage({ type: 'stop' });
        })
      );
    }

    if (this.ocrWorker) {
      stopPromises.push(
        new Promise((resolve) => {
          this.ocrWorker!.once('exit', () => resolve());
          this.ocrWorker!.postMessage({ type: 'stop' });
        })
      );
    }

    await Promise.all(stopPromises);
    logger.info('[VisionWorkerManager] All workers stopped');
  }

  private handleWorkerLog(workerName: string, msg: any): void {
    const { level, message, args } = msg;
    const formattedMessage = `[${workerName}] ${message}`;

    switch (level) {
      case 'info':
        logger.info(formattedMessage, ...args);
        break;
      case 'warn':
        logger.warn(formattedMessage, ...args);
        break;
      case 'error':
        logger.error(formattedMessage, ...args);
        break;
      case 'debug':
        logger.debug(formattedMessage, ...args);
        break;
    }
  }

  private async restartScreenCaptureWorker(): Promise<void> {
    const attempts = this.restartAttempts.get('screenCapture') || 0;

    if (attempts >= this.MAX_RESTART_ATTEMPTS) {
      logger.error('[VisionWorkerManager] Max restart attempts reached for screen capture worker');
      return;
    }

    this.restartAttempts.set('screenCapture', attempts + 1);
    logger.info(`[VisionWorkerManager] Restarting screen capture worker (attempt ${attempts + 1})`);

    try {
      // Clean up existing worker
      if (this.screenCaptureWorker) {
        this.screenCaptureWorker.removeAllListeners();
        this.screenCaptureWorker = null;
      }

      // Start new worker
      await this.startScreenCaptureWorker();

      // Reset restart counter on successful start
      this.restartAttempts.set('screenCapture', 0);
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to restart screen capture worker:', error);
    }
  }

  private async restartFlorence2Worker(): Promise<void> {
    const attempts = this.restartAttempts.get('florence2') || 0;

    if (attempts >= this.MAX_RESTART_ATTEMPTS) {
      logger.error('[VisionWorkerManager] Max restart attempts reached for Florence2 worker');
      return;
    }

    this.restartAttempts.set('florence2', attempts + 1);
    logger.info(`[VisionWorkerManager] Restarting Florence2 worker (attempt ${attempts + 1})`);

    try {
      // Clean up existing worker
      if (this.florence2Worker) {
        this.florence2Worker.removeAllListeners();
        this.florence2Worker = null;
      }

      // Start new worker
      await this.startFlorence2Worker();

      // Reset restart counter on successful start
      this.restartAttempts.set('florence2', 0);
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to restart Florence2 worker:', error);
    }
  }

  private async restartOCRWorker(): Promise<void> {
    const attempts = this.restartAttempts.get('ocr') || 0;

    if (attempts >= this.MAX_RESTART_ATTEMPTS) {
      logger.error('[VisionWorkerManager] Max restart attempts reached for OCR worker');
      return;
    }

    this.restartAttempts.set('ocr', attempts + 1);
    logger.info(`[VisionWorkerManager] Restarting OCR worker (attempt ${attempts + 1})`);

    try {
      // Clean up existing worker
      if (this.ocrWorker) {
        this.ocrWorker.removeAllListeners();
        this.ocrWorker = null;
      }

      // Start new worker
      await this.startOCRWorker();

      // Reset restart counter on successful start
      this.restartAttempts.set('ocr', 0);
    } catch (error) {
      logger.error('[VisionWorkerManager] Failed to restart OCR worker:', error);
    }
  }
}
