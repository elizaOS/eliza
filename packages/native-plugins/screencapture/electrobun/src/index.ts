/**
 * ScreenCapture Plugin for Electrobun
 *
 * Uses the web implementation with a native desktop screenshot
 * fast-path through the shared desktop bridge when available.
 */

import { invokeDesktopBridgeRequest } from "@elizaos/app-core";
import type {
  ScreenCapturePlugin,
  ScreenshotOptions,
  ScreenshotResult,
} from "../../src/definitions";
import { ScreenCaptureWeb } from "../../src/web";

interface NativeScreenshotResponse {
  available: boolean;
  data?: string;
}

export class ScreenCaptureElectrobun
  extends ScreenCaptureWeb
  implements ScreenCapturePlugin
{
  async captureScreenshot(
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult> {
    try {
      const screenshot =
        await invokeDesktopBridgeRequest<NativeScreenshotResponse>({
          rpcMethod: "screencaptureTakeScreenshot",
          ipcChannel: "screencapture:takeScreenshot",
        });

      if (screenshot?.available && screenshot.data) {
        return await this.toScreenshotResult(screenshot.data, options);
      }
    } catch (error) {
      console.warn(
        "[ScreenCapture] native screenshot RPC failed, falling back to getDisplayMedia:",
        error,
      );
    }

    return super.captureScreenshot(options);
  }

  private async toScreenshotResult(
    dataUrl: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult> {
    const image = await this.loadImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const format = options?.format ?? "png";

    if (format === "png") {
      return {
        base64: dataUrl.split(",")[1] ?? "",
        format,
        width,
        height,
        timestamp: Date.now(),
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }
    ctx.drawImage(image, 0, 0, width, height);

    const quality = (options?.quality ?? 100) / 100;
    const mimeType = format === "webp" ? "image/webp" : "image/jpeg";
    const convertedUrl = canvas.toDataURL(mimeType, quality);

    return {
      base64: convertedUrl.split(",")[1] ?? "",
      format,
      width,
      height,
      timestamp: Date.now(),
    };
  }

  private async loadImage(dataUrl: string): Promise<HTMLImageElement> {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error("Failed to load screenshot image"));
      image.src = dataUrl;
    });
    return image;
  }
}

// Export the plugin instance
export const ScreenCapture = new ScreenCaptureElectrobun();
