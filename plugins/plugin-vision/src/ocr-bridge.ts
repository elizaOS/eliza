/**
 * Runtime service for renderer-provided OCR requests, used by mobile/native
 * bridges that can read text from captured screen images.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";

export const OCR_BRIDGE_SERVICE_TYPE = "vision-ocr-bridge";

const REQUEST_OCR_TIMEOUT_MS = 20_000;

export interface OcrBridgeWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
  block: number;
  par: number;
  line: number;
}

export interface OcrRequest {
  requestId: string;
  createdAt: number;
  imageBase64: string;
  psm?: number;
}

interface PendingOcr {
  resolve: (words: OcrBridgeWord[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class OcrBridgeService extends Service {
  static override serviceType: string = OCR_BRIDGE_SERVICE_TYPE;
  override capabilityDescription =
    "Renderer-pulled bridge for agent-triggered on-device OCR.";

  private readonly queue: OcrRequest[] = [];
  private readonly pending = new Map<string, PendingOcr>();
  private readonly timeoutMs: number;

  constructor(runtime?: IAgentRuntime, timeoutMs = REQUEST_OCR_TIMEOUT_MS) {
    super(runtime);
    this.timeoutMs = timeoutMs;
  }

  static async start(runtime: IAgentRuntime): Promise<OcrBridgeService> {
    return new OcrBridgeService(runtime);
  }

  requestOcr(
    pngBytes: Uint8Array,
    psm?: number,
  ): Promise<OcrBridgeWord[] | null> {
    const requestId = crypto.randomUUID();
    const request: OcrRequest = {
      requestId,
      createdAt: Date.now(),
      imageBase64: Buffer.from(pngBytes).toString("base64"),
    };
    if (typeof psm === "number") request.psm = psm;
    this.queue.push(request);

    return new Promise<OcrBridgeWord[] | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        logger.debug(
          `[OcrBridgeService] OCR request ${requestId} timed out after ${this.timeoutMs}ms`,
        );
        resolve(null);
      }, this.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(requestId, { resolve, timer });
    });
  }

  takeRequests(): OcrRequest[] {
    return this.queue.splice(0, this.queue.length);
  }

  submitResult(requestId: string, words: OcrBridgeWord[]): boolean {
    const pendingOcr = this.pending.get(requestId);
    if (!pendingOcr) return false;
    this.pending.delete(requestId);
    clearTimeout(pendingOcr.timer);
    pendingOcr.resolve(words);
    return true;
  }

  failRequest(requestId: string, reason: string): boolean {
    const pendingOcr = this.pending.get(requestId);
    if (!pendingOcr) return false;
    this.pending.delete(requestId);
    clearTimeout(pendingOcr.timer);
    logger.debug(
      `[OcrBridgeService] OCR request ${requestId} failed: ${reason}`,
    );
    pendingOcr.resolve(null);
    return true;
  }

  async stop(): Promise<void> {
    this.queue.length = 0;
    for (const [requestId, pendingOcr] of this.pending) {
      clearTimeout(pendingOcr.timer);
      pendingOcr.resolve(null);
      this.pending.delete(requestId);
    }
  }
}
