import { WebPlugin } from "@capacitor/core";

import type {
  A2UIActionEvent,
  A2UIMessage,
  A2UIPayload,
  A2UIPushOptions,
  CanvasColor,
  CanvasDrawBatchCommand,
  CanvasDrawOptions,
  CanvasFillStyle,
  CanvasGradient,
  CanvasImageData,
  CanvasLayer,
  CanvasPath,
  CanvasPoint,
  CanvasRect,
  CanvasRenderEvent,
  CanvasSize,
  CanvasStrokeStyle,
  CanvasTextStyle,
  CanvasTouchEvent,
  CanvasTransform,
  DeepLinkEvent,
  EvalOptions,
  EvalResult,
  NavigateOptions,
  NavigationErrorEvent,
  SnapshotFormat,
  SnapshotOptions,
  SnapshotResult,
  WebViewReadyEvent,
} from "./definitions";

type CanvasEventData =
  | CanvasTouchEvent
  | CanvasRenderEvent
  | WebViewReadyEvent
  | NavigationErrorEvent
  | DeepLinkEvent
  | A2UIActionEvent;

interface ElizaA2UIBridge {
  push(
    messages: A2UIMessage[],
    jsonl: string,
    payload: A2UIPayload | null,
  ): void;
  reset(): void;
}

interface WebViewIncomingMessage {
  type: "eliza:deepLink" | "eliza:a2uiAction" | "eliza:evalResult";
  url?: string;
  path?: string;
  params?: Record<string, string>;
  action?: string;
  data?: Record<string, string | number | boolean>;
  messageId?: string;
  result?: string;
}

interface ManagedCanvas {
  id: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  layers: Map<string, ManagedLayer>;
  size: CanvasSize;
  transform: CanvasTransform;
  touchEnabled: boolean;
}

interface ManagedLayer {
  id: string;
  name?: string;
  visible: boolean;
  opacity: number;
  zIndex: number;
  transform?: CanvasTransform;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export class CanvasWeb extends WebPlugin {
  private canvases = new Map<string, ManagedCanvas>();
  private nextCanvasId = 1;
  private nextLayerId = 1;
  private pluginListeners: Array<{
    eventName: string;
    callback: (event: CanvasEventData) => void;
  }> = [];
  private webViewIframe: HTMLIFrameElement | null = null;
  private webViewPopup: Window | null = null;
  private messageListenerBound = false;

  async create(options: {
    size: CanvasSize;
    backgroundColor?: CanvasColor | string;
  }): Promise<{ canvasId: string }> {
    const canvasId = `canvas_${this.nextCanvasId++}`;

    const canvas = document.createElement("canvas");
    canvas.width = options.size.width;
    canvas.height = options.size.height;
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2D context");
    }

    if (options.backgroundColor) {
      ctx.fillStyle = this.colorToString(options.backgroundColor);
      ctx.fillRect(0, 0, options.size.width, options.size.height);
    }

    const managedCanvas: ManagedCanvas = {
      id: canvasId,
      canvas,
      ctx,
      layers: new Map(),
      size: options.size,
      transform: {},
      touchEnabled: false,
    };

    this.canvases.set(canvasId, managedCanvas);

    return { canvasId };
  }

  async destroy(options: { canvasId: string }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) return;
    managed.layers.forEach((layer) => {
      layer.canvas.remove();
    });
    managed.canvas.remove();
    this.canvases.delete(options.canvasId);
  }

  async attach(options: {
    canvasId: string;
    element: HTMLElement;
  }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    options.element.appendChild(managed.canvas);
    this.setupTouchHandlers(managed);
  }

  async detach(options: { canvasId: string }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    managed.canvas.remove();
  }

  async resize(options: { canvasId: string; size: CanvasSize }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const imageData = managed.ctx.getImageData(
      0,
      0,
      managed.canvas.width,
      managed.canvas.height,
    );

    managed.canvas.width = options.size.width;
    managed.canvas.height = options.size.height;
    managed.size = options.size;

    managed.ctx.putImageData(imageData, 0, 0);

    for (const layer of managed.layers.values()) {
      const layerImageData = layer.ctx.getImageData(
        0,
        0,
        layer.canvas.width,
        layer.canvas.height,
      );
      layer.canvas.width = options.size.width;
      layer.canvas.height = options.size.height;
      layer.ctx.putImageData(layerImageData, 0, 0);
    }
  }

  async clear(options: {
    canvasId: string;
    rect?: CanvasRect;
    layerId?: string;
  }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const ctx = options.layerId
      ? managed.layers.get(options.layerId)?.ctx
      : managed.ctx;

    if (!ctx) throw new Error("Context not found");

    if (options.rect) {
      ctx.clearRect(
        options.rect.x,
        options.rect.y,
        options.rect.width,
        options.rect.height,
      );
    } else {
      ctx.clearRect(0, 0, managed.size.width, managed.size.height);
    }
  }

  async createLayer(options: {
    canvasId: string;
    layer: Omit<CanvasLayer, "id">;
  }): Promise<{ layerId: string }> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const layerId = `layer_${this.nextLayerId++}`;

    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = managed.size.width;
    layerCanvas.height = managed.size.height;
    layerCanvas.style.position = "absolute";
    layerCanvas.style.pointerEvents = "none";
    layerCanvas.style.display = options.layer.visible ? "block" : "none";
    layerCanvas.style.opacity = String(options.layer.opacity);
    layerCanvas.style.zIndex = String(options.layer.zIndex);

    const layerCtx = layerCanvas.getContext("2d");
    if (!layerCtx) throw new Error("Failed to get layer context");

    const managedLayer: ManagedLayer = {
      id: layerId,
      name: options.layer.name,
      visible: options.layer.visible,
      opacity: options.layer.opacity,
      zIndex: options.layer.zIndex,
      transform: options.layer.transform,
      canvas: layerCanvas,
      ctx: layerCtx,
    };

    managed.layers.set(layerId, managedLayer);

    const parent = managed.canvas.parentElement;
    if (parent) {
      parent.appendChild(layerCanvas);
    }

    return { layerId };
  }

  async updateLayer(options: {
    canvasId: string;
    layerId: string;
    layer: Partial<CanvasLayer>;
  }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const layer = managed.layers.get(options.layerId);
    if (!layer) throw new Error("Layer not found");

    if (options.layer.visible !== undefined) {
      layer.visible = options.layer.visible;
      layer.canvas.style.display = options.layer.visible ? "block" : "none";
    }

    if (options.layer.opacity !== undefined) {
      layer.opacity = options.layer.opacity;
      layer.canvas.style.opacity = String(options.layer.opacity);
    }

    if (options.layer.zIndex !== undefined) {
      layer.zIndex = options.layer.zIndex;
      layer.canvas.style.zIndex = String(options.layer.zIndex);
    }

    if (options.layer.name !== undefined) {
      layer.name = options.layer.name;
    }

    if (options.layer.transform !== undefined) {
      layer.transform = options.layer.transform;
    }
  }

  async deleteLayer(options: {
    canvasId: string;
    layerId: string;
  }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const layer = managed.layers.get(options.layerId);
    if (!layer) throw new Error("Layer not found");

    layer.canvas.remove();
    managed.layers.delete(options.layerId);
  }

  async getLayers(options: {
    canvasId: string;
  }): Promise<{ layers: CanvasLayer[] }> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const layers: CanvasLayer[] = Array.from(managed.layers.values()).map(
      (layer) => ({
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        opacity: layer.opacity,
        zIndex: layer.zIndex,
        transform: layer.transform,
      }),
    );

    return { layers };
  }

  async drawRect(options: {
    canvasId: string;
    rect: CanvasRect;
    fill?: CanvasFillStyle | CanvasGradient;
    stroke?: CanvasStrokeStyle;
    cornerRadius?: number;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void> {
    const ctx = this.getContext(options.canvasId, options.drawOptions?.layerId);

    this.applyDrawOptions(ctx, options.canvasId, options.drawOptions);

    ctx.beginPath();

    if (options.cornerRadius && options.cornerRadius > 0) {
      const r = options.cornerRadius;
      const { x, y, width, height } = options.rect;
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    } else {
      ctx.rect(
        options.rect.x,
        options.rect.y,
        options.rect.width,
        options.rect.height,
      );
    }

    if (options.fill) {
      ctx.fillStyle = this.createFillStyle(ctx, options.fill);
      ctx.fill();
    }

    if (options.stroke) {
      this.applyStrokeStyle(ctx, options.stroke);
      ctx.stroke();
    }

    ctx.restore();
  }

  async drawEllipse(options: {
    canvasId: string;
    center: CanvasPoint;
    radiusX: number;
    radiusY: number;
    fill?: CanvasFillStyle | CanvasGradient;
    stroke?: CanvasStrokeStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void> {
    const ctx = this.getContext(options.canvasId, options.drawOptions?.layerId);

    this.applyDrawOptions(ctx, options.canvasId, options.drawOptions);

    ctx.beginPath();
    ctx.ellipse(
      options.center.x,
      options.center.y,
      options.radiusX,
      options.radiusY,
      0,
      0,
      Math.PI * 2,
    );

    if (options.fill) {
      ctx.fillStyle = this.createFillStyle(ctx, options.fill);
      ctx.fill();
    }

    if (options.stroke) {
      this.applyStrokeStyle(ctx, options.stroke);
      ctx.stroke();
    }

    ctx.restore();
  }

  async drawLine(options: {
    canvasId: string;
    from: CanvasPoint;
    to: CanvasPoint;
    stroke: CanvasStrokeStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void> {
    const ctx = this.getContext(options.canvasId, options.drawOptions?.layerId);

    this.applyDrawOptions(ctx, options.canvasId, options.drawOptions);
    this.applyStrokeStyle(ctx, options.stroke);

    ctx.beginPath();
    ctx.moveTo(options.from.x, options.from.y);
    ctx.lineTo(options.to.x, options.to.y);
    ctx.stroke();

    ctx.restore();
  }

  async drawPath(options: {
    canvasId: string;
    path: CanvasPath;
    fill?: CanvasFillStyle | CanvasGradient;
    stroke?: CanvasStrokeStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void> {
    const ctx = this.getContext(options.canvasId, options.drawOptions?.layerId);

    this.applyDrawOptions(ctx, options.canvasId, options.drawOptions);

    ctx.beginPath();

    for (const cmd of options.path.commands) {
      switch (cmd.type) {
        case "moveTo":
          ctx.moveTo(cmd.args[0], cmd.args[1]);
          break;
        case "lineTo":
          ctx.lineTo(cmd.args[0], cmd.args[1]);
          break;
        case "quadraticCurveTo":
          ctx.quadraticCurveTo(
            cmd.args[0],
            cmd.args[1],
            cmd.args[2],
            cmd.args[3],
          );
          break;
        case "bezierCurveTo":
          ctx.bezierCurveTo(
            cmd.args[0],
            cmd.args[1],
            cmd.args[2],
            cmd.args[3],
            cmd.args[4],
            cmd.args[5],
          );
          break;
        case "arcTo":
          ctx.arcTo(
            cmd.args[0],
            cmd.args[1],
            cmd.args[2],
            cmd.args[3],
            cmd.args[4],
          );
          break;
        case "arc":
          ctx.arc(
            cmd.args[0],
            cmd.args[1],
            cmd.args[2],
            cmd.args[3],
            cmd.args[4],
            cmd.args[5] === 1,
          );
          break;
        case "ellipse":
          ctx.ellipse(
            cmd.args[0],
            cmd.args[1],
            cmd.args[2],
            cmd.args[3],
            cmd.args[4],
            cmd.args[5],
            cmd.args[6],
            cmd.args[7] === 1,
          );
          break;
        case "rect":
          ctx.rect(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3]);
          break;
        case "closePath":
          ctx.closePath();
          break;
      }
    }

    if (options.fill) {
      ctx.fillStyle = this.createFillStyle(ctx, options.fill);
      ctx.fill();
    }

    if (options.stroke) {
      this.applyStrokeStyle(ctx, options.stroke);
      ctx.stroke();
    }

    ctx.restore();
  }

  async drawText(options: {
    canvasId: string;
    text: string;
    position: CanvasPoint;
    style: CanvasTextStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void> {
    const ctx = this.getContext(options.canvasId, options.drawOptions?.layerId);

    this.applyDrawOptions(ctx, options.canvasId, options.drawOptions);

    ctx.font = `${options.style.size}px ${options.style.font}`;
    ctx.fillStyle = this.colorToString(options.style.color);
    ctx.textAlign = options.style.align || "left";
    ctx.textBaseline = (options.style.baseline ||
      "alphabetic") as CanvasTextBaseline;

    if (options.style.maxWidth) {
      ctx.fillText(
        options.text,
        options.position.x,
        options.position.y,
        options.style.maxWidth,
      );
    } else {
      ctx.fillText(options.text, options.position.x, options.position.y);
    }

    ctx.restore();
  }

  async drawImage(options: {
    canvasId: string;
    image: CanvasImageData | string;
    destRect: CanvasRect;
    srcRect?: CanvasRect;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void> {
    const ctx = this.getContext(options.canvasId, options.drawOptions?.layerId);

    this.applyDrawOptions(ctx, options.canvasId, options.drawOptions);

    const img = new Image();

    if (typeof options.image === "string") {
      img.src = options.image;
    } else {
      img.src = `data:image/${options.image.format};base64,${options.image.base64}`;
    }

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load image"));
    });

    if (options.srcRect) {
      ctx.drawImage(
        img,
        options.srcRect.x,
        options.srcRect.y,
        options.srcRect.width,
        options.srcRect.height,
        options.destRect.x,
        options.destRect.y,
        options.destRect.width,
        options.destRect.height,
      );
    } else {
      ctx.drawImage(
        img,
        options.destRect.x,
        options.destRect.y,
        options.destRect.width,
        options.destRect.height,
      );
    }

    ctx.restore();
  }

  async drawBatch(options: {
    canvasId: string;
    commands: CanvasDrawBatchCommand[];
  }): Promise<void> {
    const base = { canvasId: options.canvasId };
    for (const cmd of options.commands) {
      switch (cmd.type) {
        case "rect":
          await this.drawRect({ ...base, ...cmd.args });
          break;
        case "ellipse":
          await this.drawEllipse({ ...base, ...cmd.args });
          break;
        case "line":
          await this.drawLine({ ...base, ...cmd.args });
          break;
        case "path":
          await this.drawPath({ ...base, ...cmd.args });
          break;
        case "text":
          await this.drawText({ ...base, ...cmd.args });
          break;
        case "image":
          await this.drawImage({ ...base, ...cmd.args });
          break;
        case "clear":
          await this.clear({ ...base, ...cmd.args });
          break;
      }
    }
  }

  async getPixelData(options: {
    canvasId: string;
    rect?: CanvasRect;
  }): Promise<{
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const rect = options.rect || {
      x: 0,
      y: 0,
      width: managed.size.width,
      height: managed.size.height,
    };
    const imageData = managed.ctx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    );

    return {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    };
  }

  async toImage(options: {
    canvasId: string;
    format?: "png" | "jpeg" | "webp";
    quality?: number;
    layerIds?: string[];
  }): Promise<CanvasImageData> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    const format = options.format || "png";
    const quality = (options.quality || 100) / 100;

    let sourceCanvas = managed.canvas;

    if (options.layerIds && options.layerIds.length > 0) {
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = managed.size.width;
      tempCanvas.height = managed.size.height;
      const tempCtx = tempCanvas.getContext("2d");

      if (!tempCtx) throw new Error("Failed to create temp canvas");

      for (const layerId of options.layerIds) {
        const layer = managed.layers.get(layerId);
        if (layer?.visible) {
          tempCtx.globalAlpha = layer.opacity;
          tempCtx.drawImage(layer.canvas, 0, 0);
        }
      }

      sourceCanvas = tempCanvas;
    }

    const mimeType =
      format === "png"
        ? "image/png"
        : format === "webp"
          ? "image/webp"
          : "image/jpeg";
    const dataUrl = sourceCanvas.toDataURL(mimeType, quality);
    const base64 = dataUrl.split(",")[1];

    return {
      base64,
      format,
      width: managed.size.width,
      height: managed.size.height,
    };
  }

  async setTransform(options: {
    canvasId: string;
    transform: CanvasTransform;
  }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    managed.transform = options.transform;
  }

  async resetTransform(options: { canvasId: string }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    managed.transform = {};
    managed.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  async setTouchEnabled(options: {
    canvasId: string;
    enabled: boolean;
  }): Promise<void> {
    const managed = this.canvases.get(options.canvasId);
    if (!managed) throw new Error("Canvas not found");

    managed.touchEnabled = options.enabled;
  }

  // ---- Web View Methods ----

  async navigate(options: NavigateOptions): Promise<void> {
    const placement = options.placement || "inline";

    // Clean up any existing web view
    this.destroyWebView();

    // Intercept eliza:// deep links immediately
    if (options.url.startsWith("eliza://")) {
      const parsed = new URL(options.url);
      const params: Record<string, string> = {};
      parsed.searchParams.forEach((value, key) => {
        params[key] = value;
      });
      this.notifyListeners("deepLink", {
        url: options.url,
        path: parsed.pathname,
        params,
      });
      return;
    }

    if (placement === "popup") {
      const popup = window.open(
        options.url,
        "_blank",
        "width=800,height=600,menubar=no,toolbar=no",
      );
      if (!popup) {
        this.notifyListeners("navigationError", {
          url: options.url,
          code: -1,
          message: "Popup blocked by browser",
        });
        return;
      }
      this.webViewPopup = popup;
      // Poll to detect when popup loads (cross-origin limits apply)
      const checkReady = setInterval(() => {
        try {
          if (popup.closed) {
            clearInterval(checkReady);
            return;
          }
          // Same-origin: can read title
          const title = popup.document?.title || "";
          clearInterval(checkReady);
          this.notifyListeners("webViewReady", { url: options.url, title });
        } catch {
          // Cross-origin: fire ready without title
          clearInterval(checkReady);
          this.notifyListeners("webViewReady", { url: options.url, title: "" });
        }
      }, 200);
      return;
    }

    // Inline or fullscreen: use an iframe
    const iframe = document.createElement("iframe");
    iframe.style.border = "none";
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups",
    );

    if (placement === "fullscreen") {
      iframe.style.position = "fixed";
      iframe.style.top = "0";
      iframe.style.left = "0";
      iframe.style.width = "100vw";
      iframe.style.height = "100vh";
      iframe.style.zIndex = "999999";
      iframe.style.backgroundColor = "#fff";
    } else {
      iframe.style.width = "100%";
      iframe.style.height = "100%";
    }

    iframe.addEventListener("load", () => {
      let title = "";
      try {
        title = iframe.contentDocument?.title || "";
      } catch {
        // Cross-origin: title inaccessible
      }
      this.notifyListeners("webViewReady", { url: options.url, title });
    });

    iframe.addEventListener("error", () => {
      this.notifyListeners("navigationError", {
        url: options.url,
        code: -1,
        message: "Failed to load URL in iframe",
      });
    });

    iframe.src = options.url;
    document.body.appendChild(iframe);
    this.webViewIframe = iframe;
    this.ensureMessageListener();
  }

  async eval(options: EvalOptions): Promise<EvalResult> {
    const target =
      this.webViewIframe?.contentWindow ??
      (this.webViewPopup && !this.webViewPopup.closed
        ? this.webViewPopup
        : null);

    if (!target) {
      throw new Error("No web view active. Call navigate() first.");
    }

    return this.evalViaPostMessage(target, options.script);
  }

  async snapshot(options?: SnapshotOptions): Promise<SnapshotResult> {
    if (!this.webViewIframe) {
      throw new Error(
        "No web view active or web view opened as popup (snapshot requires inline/fullscreen placement)",
      );
    }

    const format: SnapshotFormat = options?.format || "png";
    const quality = (options?.quality || 85) / 100;

    const iframeRect = this.webViewIframe.getBoundingClientRect();
    let width = Math.round(iframeRect.width) || 800;
    let height = Math.round(iframeRect.height) || 600;

    if (options?.maxWidth && width > options.maxWidth) {
      const scale = options.maxWidth / width;
      height = Math.round(height * scale);
      width = options.maxWidth;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create snapshot canvas context");

    // Attempt same-origin capture via DOM serialization + SVG foreignObject
    let captured = false;
    try {
      const iframeDoc = this.webViewIframe.contentDocument;
      if (iframeDoc) {
        const serializer = new XMLSerializer();
        const htmlString = serializer.serializeToString(iframeDoc);
        const svgParts = [
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
          `<foreignObject width="100%" height="100%">`,
          htmlString,
          `</foreignObject>`,
          `</svg>`,
        ];

        const img = new Image();
        const blob = new Blob([svgParts.join("")], {
          type: "image/svg+xml;charset=utf-8",
        });
        const blobUrl = URL.createObjectURL(blob);

        try {
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("SVG render failed"));
            img.src = blobUrl;
          });
          ctx.drawImage(img, 0, 0, width, height);
          captured = true;
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      }
    } catch {
      // Cross-origin or serialization failed — fall through to placeholder
    }

    if (!captured) {
      // Render a placeholder indicating cross-origin limitation
      ctx.fillStyle = "#f5f5f5";
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = "#ccc";
      ctx.strokeRect(0, 0, width, height);
      ctx.fillStyle = "#888";
      ctx.font = "14px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        "Snapshot unavailable (cross-origin content)",
        width / 2,
        height / 2,
      );
    }

    const mimeType =
      format === "jpeg"
        ? "image/jpeg"
        : format === "webp"
          ? "image/webp"
          : "image/png";
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const base64 = dataUrl.split(",")[1];

    return { base64, width, height, format };
  }

  async a2uiPush(options: A2UIPushOptions): Promise<void> {
    // Try window.elizaA2UI bridge first (set up by the A2UI runtime)
    const bridge = (window as Window & { elizaA2UI?: ElizaA2UIBridge })
      .elizaA2UI;
    if (bridge?.push) {
      bridge.push(
        options.messages || [],
        options.jsonl || "",
        options.payload || null,
      );
      return;
    }

    // Fall back to postMessage into the web view
    const target =
      this.webViewIframe?.contentWindow ||
      (this.webViewPopup && !this.webViewPopup.closed
        ? this.webViewPopup
        : null);

    if (target) {
      target.postMessage(
        {
          type: "eliza:a2uiPush",
          messages: options.messages || [],
          jsonl: options.jsonl || "",
          payload: options.payload || null,
        },
        "*",
      );
      return;
    }

    throw new Error("No A2UI bridge or web view available");
  }

  async a2uiReset(): Promise<void> {
    // Try window.elizaA2UI bridge first
    const bridge = (window as Window & { elizaA2UI?: ElizaA2UIBridge })
      .elizaA2UI;
    if (bridge?.reset) {
      bridge.reset();
      return;
    }

    // Fall back to postMessage into the web view
    const target =
      this.webViewIframe?.contentWindow ||
      (this.webViewPopup && !this.webViewPopup.closed
        ? this.webViewPopup
        : null);

    if (target) {
      target.postMessage({ type: "eliza:a2uiReset" }, "*");
      return;
    }

    throw new Error("No A2UI bridge or web view available");
  }

  // ---- Web View Helpers ----

  private destroyWebView(): void {
    if (this.webViewIframe) {
      this.webViewIframe.remove();
      this.webViewIframe = null;
    }
    if (this.webViewPopup && !this.webViewPopup.closed) {
      this.webViewPopup.close();
    }
    this.webViewPopup = null;
  }

  private evalViaPostMessage(
    target: Window,
    script: string,
  ): Promise<EvalResult> {
    return new Promise<EvalResult>((resolve, reject) => {
      const timeoutMs = 5000;
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error("eval timed out waiting for response from web view"));
      }, timeoutMs);

      const handler = (event: MessageEvent) => {
        const msg = event.data as WebViewIncomingMessage;
        if (msg?.type === "eliza:evalResult" && msg.result !== undefined) {
          clearTimeout(timeout);
          window.removeEventListener("message", handler);
          resolve({ result: String(msg.result) });
        }
      };

      window.addEventListener("message", handler);
      target.postMessage({ type: "eliza:eval", script }, "*");
    });
  }

  private ensureMessageListener(): void {
    if (this.messageListenerBound) return;
    this.messageListenerBound = true;

    window.addEventListener("message", (event: MessageEvent) => {
      // Only accept messages from our web view
      const iframeSrc = this.webViewIframe?.contentWindow;
      const popupSrc = this.webViewPopup;
      if (event.source !== iframeSrc && event.source !== popupSrc) return;

      const msg = event.data as WebViewIncomingMessage;
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "eliza:deepLink" && msg.url && msg.path) {
        this.notifyListeners("deepLink", {
          url: msg.url,
          path: msg.path,
          params: msg.params || {},
        });
      }

      if (msg.type === "eliza:a2uiAction" && msg.action) {
        this.notifyListeners("a2uiAction", {
          action: msg.action,
          data: msg.data || {},
          messageId: msg.messageId,
        });
      }
    });
  }

  // ---- Drawing Helpers ----

  private getContext(
    canvasId: string,
    layerId?: string,
  ): CanvasRenderingContext2D {
    const managed = this.canvases.get(canvasId);
    if (!managed) throw new Error("Canvas not found");

    if (layerId) {
      const layer = managed.layers.get(layerId);
      if (!layer) throw new Error("Layer not found");
      return layer.ctx;
    }

    return managed.ctx;
  }

  private colorToString(color: CanvasColor | string): string {
    if (typeof color === "string") return color;
    const a = color.a !== undefined ? color.a : 1;
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${a})`;
  }

  private createFillStyle(
    ctx: CanvasRenderingContext2D,
    fill: CanvasFillStyle | CanvasGradient,
  ): string | CanvasGradient2D {
    if ("type" in fill) {
      return this.createGradient(ctx, fill);
    }
    return this.colorToString(fill.color);
  }

  private createGradient(
    ctx: CanvasRenderingContext2D,
    gradient: CanvasGradient,
  ): CanvasGradient2D {
    let grad: CanvasGradient2D;

    if (gradient.type === "linear") {
      grad = ctx.createLinearGradient(
        gradient.x0,
        gradient.y0,
        gradient.x1,
        gradient.y1,
      );
    } else {
      grad = ctx.createRadialGradient(
        gradient.x0,
        gradient.y0,
        gradient.r0,
        gradient.x1,
        gradient.y1,
        gradient.r1,
      );
    }

    for (const stop of gradient.stops) {
      grad.addColorStop(stop.offset, this.colorToString(stop.color));
    }

    return grad;
  }

  private applyStrokeStyle(
    ctx: CanvasRenderingContext2D,
    stroke: CanvasStrokeStyle,
  ): void {
    ctx.strokeStyle = this.colorToString(stroke.color);
    ctx.lineWidth = stroke.width;
    ctx.lineCap = stroke.lineCap || "butt";
    ctx.lineJoin = stroke.lineJoin || "miter";

    if (stroke.dashPattern) {
      ctx.setLineDash(stroke.dashPattern);
    } else {
      ctx.setLineDash([]);
    }
  }

  private applyDrawOptions(
    ctx: CanvasRenderingContext2D,
    canvasId: string,
    options?: CanvasDrawOptions,
  ): void {
    ctx.save();

    // Apply canvas-level transform first (from setTransform)
    const managed = this.canvases.get(canvasId);
    if (managed && Object.keys(managed.transform).length > 0) {
      this.applyTransform(ctx, managed.transform);
    }

    if (options?.opacity !== undefined) {
      ctx.globalAlpha = options.opacity;
    }

    if (options?.blendMode) {
      const blendMap: Record<string, GlobalCompositeOperation> = {
        normal: "source-over",
        multiply: "multiply",
        screen: "screen",
        overlay: "overlay",
        darken: "darken",
        lighten: "lighten",
        "color-dodge": "color-dodge",
        "color-burn": "color-burn",
      };
      ctx.globalCompositeOperation =
        blendMap[options.blendMode] ?? "source-over";
    }

    if (options?.shadow) {
      ctx.shadowColor = this.colorToString(options.shadow.color);
      ctx.shadowBlur = options.shadow.blur;
      ctx.shadowOffsetX = options.shadow.offsetX;
      ctx.shadowOffsetY = options.shadow.offsetY;
    }

    // Apply draw-specific transform on top of canvas transform
    if (options?.transform) {
      this.applyTransform(ctx, options.transform);
    }
  }

  private applyTransform(
    ctx: CanvasRenderingContext2D,
    transform: CanvasTransform,
  ): void {
    if (transform.translateX || transform.translateY) {
      ctx.translate(transform.translateX || 0, transform.translateY || 0);
    }

    if (transform.rotation) {
      ctx.rotate(transform.rotation);
    }

    if (transform.scaleX !== undefined || transform.scaleY !== undefined) {
      ctx.scale(transform.scaleX ?? 1, transform.scaleY ?? 1);
    }

    if (transform.skewX || transform.skewY) {
      ctx.transform(1, transform.skewY || 0, transform.skewX || 0, 1, 0, 0);
    }
  }

  private setupTouchHandlers(managed: ManagedCanvas): void {
    const getScaledCoords = (clientX: number, clientY: number) => {
      const rect = managed.canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (managed.size.width / rect.width),
        y: (clientY - rect.top) * (managed.size.height / rect.height),
      };
    };

    const emitTouch = (
      type: CanvasTouchEvent["type"],
      touches: CanvasTouchEvent["touches"],
    ) => {
      this.notifyListeners("touch", { type, touches, timestamp: Date.now() });
    };

    const handleTouchEvent = (
      e: TouchEvent,
      type: CanvasTouchEvent["type"],
    ) => {
      if (!managed.touchEnabled) return;
      const touches = Array.from(e.touches).map((t) => ({
        id: t.identifier,
        ...getScaledCoords(t.clientX, t.clientY),
        force: t.force || undefined,
      }));
      emitTouch(type, touches);
    };

    managed.canvas.addEventListener("touchstart", (e) =>
      handleTouchEvent(e, "start"),
    );
    managed.canvas.addEventListener("touchmove", (e) =>
      handleTouchEvent(e, "move"),
    );
    managed.canvas.addEventListener("touchend", (e) =>
      handleTouchEvent(e, "end"),
    );
    managed.canvas.addEventListener("touchcancel", (e) =>
      handleTouchEvent(e, "cancel"),
    );

    managed.canvas.addEventListener("mousedown", (e) => {
      if (!managed.touchEnabled) return;
      emitTouch("start", [{ id: 0, ...getScaledCoords(e.clientX, e.clientY) }]);
    });

    managed.canvas.addEventListener("mousemove", (e) => {
      if (!managed.touchEnabled || e.buttons !== 1) return;
      emitTouch("move", [{ id: 0, ...getScaledCoords(e.clientX, e.clientY) }]);
    });

    managed.canvas.addEventListener("mouseup", () => {
      if (!managed.touchEnabled) return;
      emitTouch("end", []);
    });
  }

  async addListener(
    eventName: string,
    listenerFunc: (event: CanvasEventData) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    const entry = { eventName, callback: listenerFunc };
    this.pluginListeners.push(entry);
    return {
      remove: async () => {
        const i = this.pluginListeners.indexOf(entry);
        if (i >= 0) this.pluginListeners.splice(i, 1);
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    this.pluginListeners = [];
  }

  protected notifyListeners(eventName: string, data: CanvasEventData): void {
    this.pluginListeners
      .filter((l) => l.eventName === eventName)
      .forEach((l) => {
        l.callback(data);
      });
  }
}

type CanvasGradient2D = globalThis.CanvasGradient;
