/**
 * ScreenCapture Plugin for Electron
 *
 * Uses the web implementation with an Electron desktopCapturer
 * fast-path for screenshots when available.
 */

import type { ScreenCapturePlugin, ScreenshotOptions, ScreenshotResult } from "../../src/definitions";
import { ScreenCaptureWeb } from "../../src/web";

interface DesktopCapturerThumbnail {
  toDataURL(): string;
  getSize(): { width: number; height: number };
}

interface DesktopCapturerSource {
  id: string;
  name: string;
  thumbnail: DesktopCapturerThumbnail;
}

interface ElectronDesktopCapturer {
  getSources(options: {
    types: Array<"screen" | "window">;
    thumbnailSize?: { width: number; height: number };
  }): Promise<DesktopCapturerSource[]>;
}

declare global {
  interface Window {
    electron?: {
      desktopCapturer?: ElectronDesktopCapturer;
    };
  }
}

export class ScreenCaptureElectron extends ScreenCaptureWeb implements ScreenCapturePlugin {
  async captureScreenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    if (window.electron?.desktopCapturer) {
      try {
        const scale = options?.scale ?? 1;
        const targetWidth = Math.round(window.screen.width * scale);
        const targetHeight = Math.round(window.screen.height * scale);

        const sources = await window.electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: targetWidth, height: targetHeight },
        });

        if (sources.length > 0) {
          const source = sources[0];
          const size = source.thumbnail.getSize();
          const dataUrl = source.thumbnail.toDataURL();

          const format = options?.format ?? "png";
          if (format === "png") {
            return {
              base64: dataUrl.split(",")[1],
              format,
              width: size.width,
              height: size.height,
              timestamp: Date.now(),
            };
          }

          const image = new Image();
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("Failed to load screenshot image"));
            image.src = dataUrl;
          });

          const canvas = document.createElement("canvas");
          canvas.width = size.width;
          canvas.height = size.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            throw new Error("Failed to get canvas context");
          }
          ctx.drawImage(image, 0, 0, size.width, size.height);

          const quality = (options?.quality ?? 100) / 100;
          const mimeType = format === "webp" ? "image/webp" : "image/jpeg";
          const convertedUrl = canvas.toDataURL(mimeType, quality);

          return {
            base64: convertedUrl.split(",")[1],
            format,
            width: size.width,
            height: size.height,
            timestamp: Date.now(),
          };
        }
      } catch (error) {
        console.warn("[ScreenCapture] desktopCapturer failed, falling back to getDisplayMedia:", error);
      }
    }

    return super.captureScreenshot(options);
  }
}

// Export the plugin instance
export const ScreenCapture = new ScreenCaptureElectron();
