/**
 * Coordinate-aware OCR adapter that delegates screen-image recognition to the
 * Android renderer bridge and maps returned words into vision OCR blocks.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  OCR_BRIDGE_SERVICE_TYPE,
  type OcrBridgeService,
  type OcrBridgeWord,
} from "./ocr-bridge.js";
import {
  computeSemanticPosition,
  type OcrWithCoordsBlock,
  type OcrWithCoordsInput,
  type OcrWithCoordsResult,
  type OcrWithCoordsService,
  type OcrWithCoordsWord,
} from "./ocr-with-coords.js";
import type { BoundingBox } from "./types.js";

function readPngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.byteLength < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false),
  };
}

function lineToBlock(
  words: readonly OcrBridgeWord[],
  tileWidth: number,
  tileHeight: number,
  sourceX: number,
  sourceY: number,
): OcrWithCoordsBlock {
  const mappedWords: OcrWithCoordsWord[] = words.map((word) => {
    const tileBox: BoundingBox = {
      x: word.left,
      y: word.top,
      width: word.width,
      height: word.height,
    };
    return {
      text: word.text,
      bbox: {
        x: word.left + sourceX,
        y: word.top + sourceY,
        width: word.width,
        height: word.height,
      },
      semantic_position: computeSemanticPosition({
        bbox: tileBox,
        tileWidth,
        tileHeight,
      }),
    };
  });

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const word of words) {
    minX = Math.min(minX, word.left);
    minY = Math.min(minY, word.top);
    maxX = Math.max(maxX, word.left + word.width);
    maxY = Math.max(maxY, word.top + word.height);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  const tileBlockBox: BoundingBox = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
  return {
    text: words.map((word) => word.text).join(" "),
    bbox: {
      x: minX + sourceX,
      y: minY + sourceY,
      width: maxX - minX,
      height: maxY - minY,
    },
    words: mappedWords,
    semantic_position: computeSemanticPosition({
      bbox: tileBlockBox,
      tileWidth,
      tileHeight,
    }),
  };
}

export function mapOcrWordsToResult(
  words: readonly OcrBridgeWord[],
  tileWidth: number,
  tileHeight: number,
  sourceX: number,
  sourceY: number,
): OcrWithCoordsResult {
  const safeWidth = tileWidth > 0 ? tileWidth : 1;
  const safeHeight = tileHeight > 0 ? tileHeight : 1;
  const order: string[] = [];
  const groups = new Map<string, OcrBridgeWord[]>();
  for (const word of words) {
    if (word.text.trim().length === 0) continue;
    const key = `${word.block}/${word.par}/${word.line}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(word);
  }
  return {
    blocks: order.map((key) =>
      lineToBlock(
        groups.get(key) as OcrBridgeWord[],
        safeWidth,
        safeHeight,
        sourceX,
        sourceY,
      ),
    ),
  };
}

export class AndroidBridgeOcrService implements OcrWithCoordsService {
  readonly name = "android-ocr-bridge";

  constructor(private readonly runtime: IAgentRuntime) {}

  async describe(input: OcrWithCoordsInput): Promise<OcrWithCoordsResult> {
    if (input.pngBytes.byteLength === 0) return { blocks: [] };
    const bridge = this.runtime.getService<OcrBridgeService>(
      OCR_BRIDGE_SERVICE_TYPE,
    );
    if (!bridge) return { blocks: [] };
    const words = await bridge.requestOcr(input.pngBytes);
    if (!words || words.length === 0) return { blocks: [] };
    try {
      const { width, height } = readPngDimensions(input.pngBytes);
      return mapOcrWordsToResult(
        words,
        width,
        height,
        input.sourceX,
        input.sourceY,
      );
    } catch (error) {
      logger.warn(
        `[AndroidBridgeOcrService] map failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { blocks: [] };
    }
  }
}
