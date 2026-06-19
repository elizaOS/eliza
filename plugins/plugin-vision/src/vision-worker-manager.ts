import * as path from "node:path";
import { TextDecoder } from "node:util";
import { Worker } from "node:worker_threads";
import { logger } from "@elizaos/core";
import type {
  EnhancedSceneDescription,
  OCRResult,
  ScreenCapture,
  VisionConfig,
} from "./types";

interface WorkerStats {
  fps: number;
  frameCount: number;
  lastUpdate: number;
}

export class VisionWorkerManager {
  private config: VisionConfig;

  private screenCaptureWorker: Worker | null = null;
  private ocrWorker: Worker | null = null;

  private screenBuffer: SharedArrayBuffer;
  private ocrResultsBuffer: SharedArrayBuffer;

  private screenAtomicState: Int32Array;
  private ocrResultsView: DataView;

  private readonly SCREEN_BUFFER_SIZE = 50 * 1024 * 1024;
  private readonly OCR_RESULTS_SIZE = 5 * 1024 * 1024;

  private readonly FRAME_ID_INDEX = 0;
  private readonly WIDTH_INDEX = 2;
  private readonly HEIGHT_INDEX = 3;
  private readonly DISPLAY_INDEX = 4;
  private readonly TIMESTAMP_INDEX = 5;

  private workerStats = new Map<string, WorkerStats>();

  private latestScreenCapture: ScreenCapture | null = null;
  private latestOCRResult: OCRResult | null = null;
  private lastProcessedFrameId = -1;

  private restartAttempts = new Map<string, number>();
  private readonly MAX_RESTART_ATTEMPTS = 3;

  constructor(config: VisionConfig) {
    this.config = config;

    this.screenBuffer = new SharedArrayBuffer(this.SCREEN_BUFFER_SIZE);
    this.ocrResultsBuffer = new SharedArrayBuffer(this.OCR_RESULTS_SIZE);

    this.screenAtomicState = new Int32Array(this.screenBuffer, 0, 6);
    this.ocrResultsView = new DataView(this.ocrResultsBuffer);
  }

  async initialize(): Promise<void> {
    logger.info("[VisionWorkerManager] Initializing worker threads...");

    try {
      await this.startScreenCaptureWorker();

      if (this.config.ocrEnabled) {
        await this.startOCRWorker();
      }

      logger.info("[VisionWorkerManager] All workers initialized");
    } catch (error) {
      logger.error(
        "[VisionWorkerManager] Failed to initialize workers:",
        error,
      );
      throw error;
    }
  }

  private async startScreenCaptureWorker(): Promise<void> {
    const workerPath = path.join(
      __dirname,
      "workers",
      "screen-capture-worker.js",
    );

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

    this.screenCaptureWorker.on("message", (msg) => {
      if (msg.type === "fps") {
        this.workerStats.set("screenCapture", {
          fps: msg.fps,
          frameCount: msg.frameCount,
          lastUpdate: Date.now(),
        });
      } else if (msg.type === "error") {
        logger.error("[ScreenCaptureWorker] Error:", msg.error);
      } else if (msg.type === "log") {
        this.handleWorkerLog("ScreenCaptureWorker", msg);
      }
    });

    this.screenCaptureWorker.on("error", (error) => {
      logger.error(
        "[ScreenCaptureWorker] Worker error:",
        error instanceof Error ? error.message : String(error),
      );
      setTimeout(() => this.restartScreenCaptureWorker(), 1000);
    });

    this.screenCaptureWorker.on("exit", (code) => {
      if (code !== 0) {
        logger.error(
          `[ScreenCaptureWorker] Worker stopped with exit code ${code}`,
        );
        setTimeout(() => this.restartScreenCaptureWorker(), 1000);
      }
    });
  }

  private async startOCRWorker(): Promise<void> {
    const workerPath = path.join(__dirname, "workers", "ocr-worker.js");

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

    this.ocrWorker.on("message", (msg) => {
      if (msg.type === "fps") {
        this.workerStats.set("ocr", {
          fps: msg.fps,
          frameCount: msg.frameCount,
          lastUpdate: Date.now(),
        });
      } else if (msg.type === "ocr_complete") {
        this.updateOCRCache(msg);
      } else if (msg.type === "error") {
        logger.error("[OCRWorker] Error:", msg.error);
      } else if (msg.type === "log") {
        this.handleWorkerLog("OCRWorker", msg);
      }
    });

    this.ocrWorker.on("error", (error) => {
      logger.error(
        "[OCRWorker] Worker error:",
        error instanceof Error ? error.message : String(error),
      );
      setTimeout(() => this.restartOCRWorker(), 1000);
    });

    this.ocrWorker.on("exit", (code) => {
      if (code !== 0) {
        logger.error(`[OCRWorker] Worker stopped with exit code ${code}`);
        setTimeout(() => this.restartOCRWorker(), 1000);
      }
    });
  }

  private updateOCRCache(_msg: unknown): void {
    try {
      const result = this.readOCRResult();
      if (result) {
        this.latestOCRResult = result;
      }
    } catch (error) {
      logger.error("[VisionWorkerManager] Failed to update OCR cache:", error);
    }
  }

  private readOCRResult(): OCRResult | null {
    try {
      const RESULTS_HEADER_SIZE = 16;
      const offset = RESULTS_HEADER_SIZE;

      const length = this.ocrResultsView.getUint32(offset, true);
      if (length === 0) {
        return null;
      }

      const _frameId = this.ocrResultsView.getUint32(offset + 4, true);
      const _timestamp = this.ocrResultsView.getFloat64(offset + 8, true);

      const dataOffset = offset + 16;
      const bytes = new Uint8Array(Math.min(length, 65536));
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = this.ocrResultsView.getUint8(dataOffset + i);
      }

      const json = new TextDecoder().decode(bytes);
      return JSON.parse(json);
    } catch (error) {
      logger.error("[VisionWorkerManager] Failed to read OCR result:", error);
      return null;
    }
  }

  getLatestScreenCapture(): ScreenCapture | null {
    const frameId = Atomics.load(this.screenAtomicState, this.FRAME_ID_INDEX);

    if (frameId <= this.lastProcessedFrameId) {
      return this.latestScreenCapture;
    }

    try {
      const width = Atomics.load(this.screenAtomicState, this.WIDTH_INDEX);
      const height = Atomics.load(this.screenAtomicState, this.HEIGHT_INDEX);
      const _displayIndex = Atomics.load(
        this.screenAtomicState,
        this.DISPLAY_INDEX,
      );
      const timestamp = Atomics.load(
        this.screenAtomicState,
        this.TIMESTAMP_INDEX,
      );

      this.latestScreenCapture = {
        timestamp,
        width,
        height,
        data: Buffer.alloc(0),
        tiles: this.generateTiles(width, height),
      };

      this.lastProcessedFrameId = frameId;
    } catch (error) {
      logger.error(
        "[VisionWorkerManager] Failed to read screen capture:",
        error,
      );
    }

    return this.latestScreenCapture;
  }

  getLatestEnhancedScene(): EnhancedSceneDescription {
    const screenCapture = this.getLatestScreenCapture();

    return {
      timestamp: Date.now(),
      description: this.latestOCRResult?.fullText ?? "",
      objects: [],
      people: [],
      sceneChanged: true,
      changePercentage: 100,
      screenCapture: this.latestScreenCapture || undefined,
      screenAnalysis: {
        fullScreenOCR: this.latestOCRResult?.fullText,
        activeTile: {
          timestamp: Date.now(),
          ocr: this.latestOCRResult || undefined,
        },
        gridSummary: `${screenCapture?.tiles.length || 0} tiles analyzed`,
        uiElements: [],
      },
    };
  }

  private generateTiles(
    width: number,
    height: number,
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
        type: "set_display",
        displayIndex: index,
      });
    }
  }

  async setTextRegions(
    regions: Array<{ x: number; y: number; width: number; height: number }>,
  ): Promise<void> {
    if (this.ocrWorker) {
      this.ocrWorker.postMessage({
        type: "update_regions",
        regions,
      });
    }
  }

  async stop(): Promise<void> {
    logger.info("[VisionWorkerManager] Stopping all workers...");

    const stopPromises: Promise<void>[] = [];

    if (this.screenCaptureWorker) {
      stopPromises.push(
        new Promise((resolve) => {
          this.screenCaptureWorker?.once("exit", () => resolve());
          this.screenCaptureWorker?.postMessage({ type: "stop" });
        }),
      );
    }

    if (this.ocrWorker) {
      stopPromises.push(
        new Promise((resolve) => {
          this.ocrWorker?.once("exit", () => resolve());
          this.ocrWorker?.postMessage({ type: "stop" });
        }),
      );
    }

    await Promise.all(stopPromises);
    logger.info("[VisionWorkerManager] All workers stopped");
  }

  private handleWorkerLog(
    workerName: string,
    msg: { level: string; message: string; args: unknown[] },
  ): void {
    const { level, message, args } = msg;
    const formattedMessage = `[${workerName}] ${message}`;
    const stringArgs = args.map((arg) => String(arg));

    switch (level) {
      case "info":
        logger.info(formattedMessage, ...stringArgs);
        break;
      case "warn":
        logger.warn(formattedMessage, ...stringArgs);
        break;
      case "error":
        logger.error(formattedMessage, ...stringArgs);
        break;
      case "debug":
        logger.debug(formattedMessage, ...stringArgs);
        break;
    }
  }

  private async restartScreenCaptureWorker(): Promise<void> {
    const attempts = this.restartAttempts.get("screenCapture") || 0;

    if (attempts >= this.MAX_RESTART_ATTEMPTS) {
      logger.error(
        "[VisionWorkerManager] Max restart attempts reached for screen capture worker",
      );
      return;
    }

    this.restartAttempts.set("screenCapture", attempts + 1);
    logger.info(
      `[VisionWorkerManager] Restarting screen capture worker (attempt ${attempts + 1})`,
    );

    try {
      if (this.screenCaptureWorker) {
        this.screenCaptureWorker.removeAllListeners();
        this.screenCaptureWorker = null;
      }

      await this.startScreenCaptureWorker();

      this.restartAttempts.set("screenCapture", 0);
    } catch (error) {
      logger.error(
        "[VisionWorkerManager] Failed to restart screen capture worker:",
        error,
      );
    }
  }

  private async restartOCRWorker(): Promise<void> {
    const attempts = this.restartAttempts.get("ocr") || 0;

    if (attempts >= this.MAX_RESTART_ATTEMPTS) {
      logger.error(
        "[VisionWorkerManager] Max restart attempts reached for OCR worker",
      );
      return;
    }

    this.restartAttempts.set("ocr", attempts + 1);
    logger.info(
      `[VisionWorkerManager] Restarting OCR worker (attempt ${attempts + 1})`,
    );

    try {
      if (this.ocrWorker) {
        this.ocrWorker.removeAllListeners();
        this.ocrWorker = null;
      }

      await this.startOCRWorker();

      this.restartAttempts.set("ocr", 0);
    } catch (error) {
      logger.error(
        "[VisionWorkerManager] Failed to restart OCR worker:",
        error,
      );
    }
  }
}
