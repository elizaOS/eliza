import type { IAgentRuntime, ServiceTypeName } from "@elizaos/core";
import {
  registerOcrProvider,
  type OcrProvider,
  type OcrResult,
} from "../mobile/ocr-provider.js";

interface VisionBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface VisionOcrResult {
  text: string;
  fullText: string;
  blocks: Array<{
    text: string;
    confidence: number;
    bbox: VisionBoundingBox;
  }>;
}

type VisionOcrService = {
  recognizeImageText?: (imageBuffer: Buffer) => Promise<VisionOcrResult>;
};

const PROVIDER_NAME = "plugin-vision-ocr";

function getVisionService(runtime: IAgentRuntime): VisionOcrService | null {
  const service = runtime.getService?.("VISION" as ServiceTypeName);
  if (!service || typeof service !== "object") return null;
  return service as VisionOcrService;
}

function mapOcrResult(result: VisionOcrResult): OcrResult {
  return {
    lines: result.blocks.map((block) => ({
      text: block.text,
      confidence: block.confidence,
      boundingBox: {
        x: block.bbox.x,
        y: block.bbox.y,
        width: block.bbox.width,
        height: block.bbox.height,
      },
    })),
    fullText: result.fullText || result.text,
    elapsedMs: 0,
    providerName: PROVIDER_NAME,
    languagesUsed: [],
  };
}

export function registerVisionOcrProvider(runtime: IAgentRuntime): void {
  const provider: OcrProvider = {
    name: PROVIDER_NAME,
    priority: 80,
    available(): boolean {
      return typeof getVisionService(runtime)?.recognizeImageText === "function";
    },
    async recognize(input): Promise<OcrResult> {
      const service = getVisionService(runtime);
      if (typeof service?.recognizeImageText !== "function") {
        throw new Error("plugin-vision OCR service is not available");
      }
      const buffer =
        input.kind === "bytes"
          ? Buffer.from(input.data)
          : Buffer.from(input.data, "base64");
      return mapOcrResult(await service.recognizeImageText(buffer));
    },
  };
  registerOcrProvider(provider);
}
