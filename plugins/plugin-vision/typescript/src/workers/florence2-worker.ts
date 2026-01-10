import { parentPort, workerData } from 'worker_threads';
import { logger } from './worker-logger';
import { Florence2Model } from '../florence2-model';
import type { Florence2Result, ScreenTile } from '../types';
import sharp from 'sharp';

interface WorkerConfig {
  tileSize: number;
  priorityTiles?: number[]; // Indices of tiles to prioritize
}

interface SharedMetadata {
  frameId: number;
  width: number;
  height: number;
  displayIndex: number;
  timestamp: number;
}

class Florence2Worker {
  private config: WorkerConfig;
  private sharedBuffer: SharedArrayBuffer;
  private dataView: DataView;
  private atomicState: Int32Array;
  private resultsBuffer: SharedArrayBuffer;
  private resultsView: DataView;
  private florence2: Florence2Model;
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
  private readonly MAX_RESULT_SIZE = 4096; // Per tile

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
    this.florence2 = new Florence2Model();
  }

  async initialize(): Promise<void> {
    await this.florence2.initialize();
    logger.info('[Florence2Worker] Initialized and ready');
  }

  async run(): Promise<void> {
    await this.initialize();

    logger.info('[Florence2Worker] Starting analysis loop...');

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
            logger.info(`[Florence2Worker] Analysis FPS: ${fps.toFixed(2)}`);

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
        logger.error('[Florence2Worker] Processing error:', error);
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

    // Calculate tiles
    const tiles = this.calculateTiles(metadata.width, metadata.height);

    // Process priority tiles first
    const tilesToProcess = this.config.priorityTiles
      ? this.config.priorityTiles.map((i) => tiles[i]).filter(Boolean)
      : tiles;

    // Process tiles
    for (let i = 0; i < tilesToProcess.length; i++) {
      const tile = tilesToProcess[i];
      if (!tile) {
        continue;
      }

      try {
        // Extract tile data from shared buffer
        const tileBuffer = await this.extractTileFromSharedBuffer(tile, metadata);

        // Analyze with Florence-2
        const result = await this.florence2.analyzeTile({
          ...tile,
          data: tileBuffer,
        });

        // Write result to results buffer
        await this.writeResultToBuffer(tile.id, result, metadata.frameId);

        // Notify main thread
        parentPort?.postMessage({
          type: 'tile_analyzed',
          tileId: tile.id,
          frameId: metadata.frameId,
          displayIndex: metadata.displayIndex,
          hasObjects: (result.objects?.length || 0) > 0,
          caption: result.caption,
        });
      } catch (error) {
        logger.error(`[Florence2Worker] Failed to analyze tile ${tile.id}:`, error);
      }
    }
  }

  private calculateTiles(width: number, height: number): ScreenTile[] {
    const tileSize = this.config.tileSize;
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

    return tiles;
  }

  private async extractTileFromSharedBuffer(
    tile: ScreenTile,
    metadata: SharedMetadata
  ): Promise<Buffer> {
    // Calculate byte positions for the tile
    const bytesPerPixel = 4; // RGBA
    const rowStride = metadata.width * bytesPerPixel;

    // Create buffer for tile data
    const tileData = Buffer.allocUnsafe(tile.width * tile.height * bytesPerPixel);

    // Copy tile data row by row
    for (let row = 0; row < tile.height; row++) {
      const sourceY = tile.y + row;
      const sourceOffset = this.DATA_OFFSET + sourceY * rowStride + tile.x * bytesPerPixel;
      const destOffset = row * tile.width * bytesPerPixel;

      // Copy one row of tile data
      for (let i = 0; i < tile.width * bytesPerPixel; i++) {
        tileData[destOffset + i] = this.dataView.getUint8(sourceOffset + i);
      }
    }

    // Convert raw RGBA to PNG for Florence-2
    const pngBuffer = await sharp(tileData, {
      raw: {
        width: tile.width,
        height: tile.height,
        channels: 4,
      },
    })
      .png()
      .toBuffer();

    return pngBuffer;
  }

  private async writeResultToBuffer(
    tileId: string,
    result: Florence2Result,
    frameId: number
  ): Promise<void> {
    // Serialize result to JSON
    const resultJson = JSON.stringify({
      tileId,
      frameId,
      timestamp: Date.now(),
      ...result,
    });

    const resultBytes = Buffer.from(resultJson, 'utf-8');

    // Calculate tile index from ID
    const match = tileId.match(/tile-(\d+)-(\d+)/);
    if (!match) {
      return;
    }

    const row = parseInt(match[1], 10);
    const col = parseInt(match[2], 10);
    const tileIndex = row * 10 + col; // Assuming max 10 columns

    // Write to results buffer
    const offset = this.RESULTS_HEADER_SIZE + tileIndex * this.MAX_RESULT_SIZE;

    // Write length
    this.resultsView.setUint32(offset, resultBytes.length, true);

    // Write data
    for (let i = 0; i < Math.min(resultBytes.length, this.MAX_RESULT_SIZE - 4); i++) {
      this.resultsView.setUint8(offset + 4 + i, resultBytes[i]);
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  async dispose(): Promise<void> {
    await this.florence2.dispose();
  }
}

// Worker entry point
if (parentPort) {
  const { config, sharedBuffer, resultsBuffer } = workerData;
  const worker = new Florence2Worker(config, sharedBuffer, resultsBuffer);

  // Handle messages from main thread
  parentPort.on('message', (msg) => {
    if (msg.type === 'stop') {
      worker.stop();
      worker.dispose().then(() => {
        parentPort?.postMessage({ type: 'stopped' });
      });
    }
  });

  // Run the worker
  worker.run().catch((error) => {
    logger.error('[Florence2Worker] Fatal error:', error);
    parentPort?.postMessage({ type: 'error', error: error.message });
    process.exit(1);
  });
}
