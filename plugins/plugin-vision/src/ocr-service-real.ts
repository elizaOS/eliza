import { logger } from '@elizaos/core';
import Tesseract from 'tesseract.js';
import type { OCRResult, ScreenTile, BoundingBox } from './types';
import sharp from 'sharp';

export class RealOCRService {
  private worker: Tesseract.Worker | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Prevent multiple initializations
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    try {
      logger.info('[RealOCR] Initializing Tesseract.js...');

      // Create worker
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            logger.debug(`[RealOCR] Progress: ${(m.progress * 100).toFixed(1)}%`);
          }
        },
      });

      this.initialized = true;
      logger.info('[RealOCR] Tesseract.js initialized successfully');
    } catch (error) {
      logger.error('[RealOCR] Failed to initialize:', error);
      throw error;
    }
  }

  async extractText(imageBuffer: Buffer): Promise<OCRResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.worker) {
      throw new Error('OCR worker not initialized');
    }

    try {
      // Preprocess image for better OCR
      const processedBuffer = await this.preprocessImage(imageBuffer);

      // Perform OCR
      const result = await this.worker.recognize(processedBuffer);

      // Convert Tesseract result to our format
      return this.convertTesseractResult(result);
    } catch (error) {
      logger.error('[RealOCR] Text extraction failed:', error);
      throw error;
    }
  }

  async extractFromTile(tile: ScreenTile): Promise<OCRResult> {
    if (!tile.data) {
      return {
        text: '',
        blocks: [],
        fullText: '',
      };
    }

    return this.extractText(tile.data);
  }

  private async preprocessImage(imageBuffer: Buffer): Promise<Buffer> {
    try {
      // Enhance image for better OCR results
      const processed = await sharp(imageBuffer)
        .grayscale() // Convert to grayscale
        .normalize() // Normalize contrast
        .sharpen() // Sharpen text
        .toBuffer();

      return processed;
    } catch (error) {
      logger.warn('[RealOCR] Image preprocessing failed, using original:', error);
      return imageBuffer;
    }
  }

  private convertTesseractResult(result: Tesseract.RecognizeResult): OCRResult {
    const blocks: OCRResult['blocks'] = [];

    // Process lines as blocks
    const lines = (result.data as any).lines || [];
    for (const line of lines) {
      if (line.confidence > 30) {
        // Filter low confidence
        blocks.push({
          text: line.text.trim(),
          bbox: {
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: line.bbox.x1 - line.bbox.x0,
            height: line.bbox.y1 - line.bbox.y0,
          },
          confidence: line.confidence / 100,
          words: line.words.map((word: any) => ({
            text: word.text,
            bbox: {
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0,
            },
            confidence: word.confidence / 100,
          })),
        });
      }
    }

    const fullText = result.data.text.trim();

    return {
      text: fullText,
      blocks,
      fullText,
    };
  }

  async extractStructuredData(imageBuffer: Buffer): Promise<{
    tables?: Array<{ rows: string[][]; bbox: BoundingBox }>;
    forms?: Array<{ label: string; value: string; bbox: BoundingBox }>;
    lists?: Array<{ items: string[]; bbox: BoundingBox }>;
  }> {
    const ocrResult = await this.extractText(imageBuffer);

    return {
      tables: this.detectTables(ocrResult),
      forms: this.detectForms(ocrResult),
      lists: this.detectLists(ocrResult),
    };
  }

  private detectTables(ocrResult: OCRResult): Array<{ rows: string[][]; bbox: BoundingBox }> {
    const tables: Array<{ rows: string[][]; bbox: BoundingBox }> = [];

    // Group blocks by vertical alignment to detect table rows
    const rows: Map<number, typeof ocrResult.blocks> = new Map();

    for (const block of ocrResult.blocks) {
      // Round Y position to group nearby blocks
      const rowY = Math.round(block.bbox.y / 20) * 20;

      if (!rows.has(rowY)) {
        rows.set(rowY, []);
      }
      rows.get(rowY)!.push(block);
    }

    // Find potential tables (multiple aligned rows)
    const sortedRows = Array.from(rows.entries()).sort((a, b) => a[0] - b[0]);

    let tableRows: string[][] = [];
    let tableBounds: BoundingBox | null = null;

    for (const [y, rowBlocks] of sortedRows) {
      if (rowBlocks.length > 1) {
        // Sort blocks by X position
        rowBlocks.sort((a, b) => a.bbox.x - b.bbox.x);

        const rowTexts = rowBlocks.map((b) => b.text);
        tableRows.push(rowTexts);

        // Update table bounds
        if (!tableBounds) {
          tableBounds = { ...rowBlocks[0].bbox };
        } else {
          tableBounds.x = Math.min(tableBounds.x, rowBlocks[0].bbox.x);
          tableBounds.width =
            Math.max(...rowBlocks.map((b) => b.bbox.x + b.bbox.width)) - tableBounds.x;
          tableBounds.height = y + rowBlocks[0].bbox.height - tableBounds.y;
        }
      } else if (tableRows.length > 1 && tableBounds) {
        // End of table
        tables.push({
          rows: [...tableRows],
          bbox: { ...tableBounds },
        });
        tableRows = [];
        tableBounds = null;
      }
    }

    // Add final table if exists
    if (tableRows.length > 1 && tableBounds) {
      tables.push({
        rows: tableRows,
        bbox: tableBounds,
      });
    }

    return tables;
  }

  private detectForms(
    ocrResult: OCRResult
  ): Array<{ label: string; value: string; bbox: BoundingBox }> {
    const forms: Array<{ label: string; value: string; bbox: BoundingBox }> = [];

    // Look for label-value patterns
    const blocks = ocrResult.blocks;

    for (let i = 0; i < blocks.length; i++) {
      const current = blocks[i];

      // Check if this looks like a label
      if (current.text.match(/[:：]\s*$/)) {
        const label = current.text.replace(/[:：]\s*$/, '').trim();

        // Look for value in nearby blocks
        for (let j = i + 1; j < blocks.length && j < i + 3; j++) {
          const next = blocks[j];

          // Check if horizontally aligned or just below
          const isAligned = Math.abs(current.bbox.y - next.bbox.y) < 10;
          const isBelow =
            next.bbox.y > current.bbox.y && next.bbox.y < current.bbox.y + current.bbox.height + 30;

          if (isAligned || isBelow) {
            forms.push({
              label,
              value: next.text.trim(),
              bbox: {
                x: Math.min(current.bbox.x, next.bbox.x),
                y: current.bbox.y,
                width:
                  Math.max(current.bbox.x + current.bbox.width, next.bbox.x + next.bbox.width) -
                  Math.min(current.bbox.x, next.bbox.x),
                height: next.bbox.y + next.bbox.height - current.bbox.y,
              },
            });
            break;
          }
        }
      }
    }

    return forms;
  }

  private detectLists(ocrResult: OCRResult): Array<{ items: string[]; bbox: BoundingBox }> {
    const lists: Array<{ items: string[]; bbox: BoundingBox }> = [];

    let currentList: string[] = [];
    let listBounds: BoundingBox | null = null;

    for (const block of ocrResult.blocks) {
      // Check for list markers
      const listMatch = block.text.match(
        /^[\u2022\u2023\u25E6\u2043\u2219•·‣⁃◦▪▫◆◇○●\-\*]\s+(.+)$/
      );
      const numberedMatch = block.text.match(/^(\d+\.|\d+\)|\(\d+\)|[a-zA-Z]\.)\s+(.+)$/);

      if (listMatch || numberedMatch) {
        const itemText = listMatch ? listMatch[1] : numberedMatch![2];
        currentList.push(itemText.trim());

        if (!listBounds) {
          listBounds = { ...block.bbox };
        } else {
          listBounds.width = Math.max(
            listBounds.width,
            block.bbox.x + block.bbox.width - listBounds.x
          );
          listBounds.height = block.bbox.y + block.bbox.height - listBounds.y;
        }
      } else if (currentList.length > 0 && listBounds) {
        // End of list
        lists.push({
          items: [...currentList],
          bbox: { ...listBounds },
        });
        currentList = [];
        listBounds = null;
      }
    }

    // Add final list if exists
    if (currentList.length > 0 && listBounds) {
      lists.push({
        items: currentList,
        bbox: listBounds,
      });
    }

    return lists;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
    this.initPromise = null;
    logger.info('[RealOCR] Disposed');
  }
}
