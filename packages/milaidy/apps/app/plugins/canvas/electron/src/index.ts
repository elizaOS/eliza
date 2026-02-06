/**
 * Canvas Plugin for Electron
 *
 * Provides HTML5 Canvas rendering capabilities on desktop platforms.
 * This is essentially the same as the web implementation since Canvas
 * is fully supported in Electron's Chromium renderer.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import type {
  CanvasPlugin,
  CanvasSize,
  CanvasRect,
  CanvasColor,
  CanvasLayer,
  CanvasStrokeStyle,
  CanvasFillStyle,
  CanvasTextStyle,
  CanvasPoint,
  CanvasPath,
  CanvasDrawOptions,
  CanvasDrawBatchCommand,
  CanvasTransform,
  CanvasImageData,
  CanvasGradient,
  CanvasTouchEvent,
  CanvasRenderEvent,
} from "../../src/definitions";

type EventCallback<T> = (event: T) => void;
type CanvasEvent = CanvasTouchEvent | CanvasRenderEvent;

interface ListenerEntry {
  eventName: string;
  callback: EventCallback<CanvasEvent>;
}

interface CanvasInstance {
  element: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  layers: Map<string, CanvasLayer>;
  attachedElement: HTMLElement | null;
  touchEnabled: boolean;
}

function colorToString(color: CanvasColor | string): string {
  if (typeof color === "string") return color;
  const { r, g, b, a = 1 } = color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function createGradient(ctx: CanvasRenderingContext2D, gradient: CanvasGradient): CanvasGradient2D {
  let canvasGradient: CanvasGradient2D;
  if (gradient.type === "linear") {
    canvasGradient = ctx.createLinearGradient(gradient.x0, gradient.y0, gradient.x1, gradient.y1);
  } else {
    canvasGradient = ctx.createRadialGradient(gradient.x0, gradient.y0, gradient.r0, gradient.x1, gradient.y1, gradient.r1);
  }
  for (const stop of gradient.stops) {
    canvasGradient.addColorStop(stop.offset, colorToString(stop.color));
  }
  return canvasGradient;
}

type CanvasGradient2D = ReturnType<CanvasRenderingContext2D["createLinearGradient"]>;

/**
 * Canvas Plugin implementation for Electron
 */
export class CanvasElectron implements CanvasPlugin {
  private canvases: Map<string, CanvasInstance> = new Map();
  private listeners: ListenerEntry[] = [];
  private canvasIdCounter = 0;
  private layerIdCounter = 0;

  // MARK: - Canvas Lifecycle

  async create(options: { size: CanvasSize; backgroundColor?: CanvasColor | string }): Promise<{ canvasId: string }> {
    const canvasId = `canvas_${++this.canvasIdCounter}`;

    const canvas = document.createElement("canvas");
    canvas.id = canvasId;
    canvas.width = options.size.width;
    canvas.height = options.size.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2D context");
    }

    if (options.backgroundColor) {
      ctx.fillStyle = colorToString(options.backgroundColor);
      ctx.fillRect(0, 0, options.size.width, options.size.height);
    }

    const instance: CanvasInstance = {
      element: canvas,
      context: ctx,
      layers: new Map(),
      attachedElement: null,
      touchEnabled: false,
    };

    this.canvases.set(canvasId, instance);
    return { canvasId };
  }

  async destroy(options: { canvasId: string }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (instance) {
      if (instance.attachedElement) {
        instance.attachedElement.removeChild(instance.element);
      }
      this.canvases.delete(options.canvasId);
    }
  }

  async attach(options: { canvasId: string; element: HTMLElement }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    if (instance.attachedElement) {
      instance.attachedElement.removeChild(instance.element);
    }

    options.element.appendChild(instance.element);
    instance.attachedElement = options.element;
  }

  async detach(options: { canvasId: string }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    if (instance.attachedElement) {
      instance.attachedElement.removeChild(instance.element);
      instance.attachedElement = null;
    }
  }

  async resize(options: { canvasId: string; size: CanvasSize }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    instance.element.width = options.size.width;
    instance.element.height = options.size.height;
  }

  async clear(options: { canvasId: string; rect?: CanvasRect; layerId?: string }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    if (options.rect) {
      ctx.clearRect(options.rect.x, options.rect.y, options.rect.width, options.rect.height);
    } else {
      ctx.clearRect(0, 0, instance.element.width, instance.element.height);
    }
  }

  // MARK: - Layer Management

  async createLayer(options: { canvasId: string; layer: Omit<CanvasLayer, "id"> }): Promise<{ layerId: string }> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const layerId = `layer_${++this.layerIdCounter}`;
    const layer: CanvasLayer = {
      ...options.layer,
      id: layerId,
    };

    instance.layers.set(layerId, layer);
    return { layerId };
  }

  async updateLayer(options: { canvasId: string; layerId: string; layer: Partial<CanvasLayer> }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const layer = instance.layers.get(options.layerId);
    if (!layer) {
      throw new Error(`Layer not found: ${options.layerId}`);
    }

    Object.assign(layer, options.layer);
  }

  async deleteLayer(options: { canvasId: string; layerId: string }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    instance.layers.delete(options.layerId);
  }

  async getLayers(options: { canvasId: string }): Promise<{ layers: CanvasLayer[] }> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    return { layers: Array.from(instance.layers.values()) };
  }

  // MARK: - Drawing Operations

  private applyDrawOptions(ctx: CanvasRenderingContext2D, drawOptions?: CanvasDrawOptions): void {
    if (!drawOptions) return;

    if (drawOptions.opacity !== undefined) {
      ctx.globalAlpha = drawOptions.opacity;
    }

    if (drawOptions.blendMode) {
      ctx.globalCompositeOperation = drawOptions.blendMode;
    }

    if (drawOptions.shadow) {
      ctx.shadowColor = colorToString(drawOptions.shadow.color);
      ctx.shadowBlur = drawOptions.shadow.blur;
      ctx.shadowOffsetX = drawOptions.shadow.offsetX;
      ctx.shadowOffsetY = drawOptions.shadow.offsetY;
    }

    if (drawOptions.transform) {
      this.applyTransform(ctx, drawOptions.transform);
    }
  }

  private applyTransform(ctx: CanvasRenderingContext2D, transform: CanvasTransform): void {
    if (transform.translateX || transform.translateY) {
      ctx.translate(transform.translateX || 0, transform.translateY || 0);
    }
    if (transform.rotation) {
      ctx.rotate(transform.rotation);
    }
    if (transform.scaleX || transform.scaleY) {
      ctx.scale(transform.scaleX || 1, transform.scaleY || 1);
    }
    if (transform.skewX || transform.skewY) {
      ctx.transform(1, transform.skewY || 0, transform.skewX || 0, 1, 0, 0);
    }
  }

  private applyStroke(ctx: CanvasRenderingContext2D, stroke: CanvasStrokeStyle): void {
    ctx.strokeStyle = colorToString(stroke.color);
    ctx.lineWidth = stroke.width;
    if (stroke.lineCap) ctx.lineCap = stroke.lineCap;
    if (stroke.lineJoin) ctx.lineJoin = stroke.lineJoin;
    if (stroke.dashPattern) ctx.setLineDash(stroke.dashPattern);
  }

  private applyFill(ctx: CanvasRenderingContext2D, fill: CanvasFillStyle | CanvasGradient): void {
    if ("type" in fill) {
      ctx.fillStyle = createGradient(ctx, fill);
    } else {
      ctx.fillStyle = colorToString(fill.color);
    }
  }

  async drawRect(options: {
    canvasId: string;
    rect: CanvasRect;
    fill?: CanvasFillStyle | CanvasGradient;
    stroke?: CanvasStrokeStyle;
    cornerRadius?: number;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    ctx.save();
    this.applyDrawOptions(ctx, options.drawOptions);

    const { x, y, width, height } = options.rect;
    const radius = options.cornerRadius || 0;

    ctx.beginPath();
    if (radius > 0) {
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.arcTo(x + width, y, x + width, y + radius, radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
      ctx.lineTo(x + radius, y + height);
      ctx.arcTo(x, y + height, x, y + height - radius, radius);
      ctx.lineTo(x, y + radius);
      ctx.arcTo(x, y, x + radius, y, radius);
    } else {
      ctx.rect(x, y, width, height);
    }
    ctx.closePath();

    if (options.fill) {
      this.applyFill(ctx, options.fill);
      ctx.fill();
    }
    if (options.stroke) {
      this.applyStroke(ctx, options.stroke);
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
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    ctx.save();
    this.applyDrawOptions(ctx, options.drawOptions);

    ctx.beginPath();
    ctx.ellipse(options.center.x, options.center.y, options.radiusX, options.radiusY, 0, 0, Math.PI * 2);
    ctx.closePath();

    if (options.fill) {
      this.applyFill(ctx, options.fill);
      ctx.fill();
    }
    if (options.stroke) {
      this.applyStroke(ctx, options.stroke);
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
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    ctx.save();
    this.applyDrawOptions(ctx, options.drawOptions);
    this.applyStroke(ctx, options.stroke);

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
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    ctx.save();
    this.applyDrawOptions(ctx, options.drawOptions);

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
          ctx.quadraticCurveTo(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3]);
          break;
        case "bezierCurveTo":
          ctx.bezierCurveTo(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3], cmd.args[4], cmd.args[5]);
          break;
        case "arcTo":
          ctx.arcTo(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3], cmd.args[4]);
          break;
        case "arc":
          ctx.arc(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3], cmd.args[4], cmd.args[5] === 1);
          break;
        case "ellipse":
          ctx.ellipse(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3], cmd.args[4], cmd.args[5], cmd.args[6], cmd.args[7] === 1);
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
      this.applyFill(ctx, options.fill);
      ctx.fill();
    }
    if (options.stroke) {
      this.applyStroke(ctx, options.stroke);
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
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    ctx.save();
    this.applyDrawOptions(ctx, options.drawOptions);

    ctx.font = `${options.style.size}px ${options.style.font}`;
    ctx.fillStyle = colorToString(options.style.color);
    if (options.style.align) ctx.textAlign = options.style.align;
    if (options.style.baseline) ctx.textBaseline = options.style.baseline;

    if (options.style.maxWidth) {
      ctx.fillText(options.text, options.position.x, options.position.y, options.style.maxWidth);
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
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        ctx.save();
        this.applyDrawOptions(ctx, options.drawOptions);

        if (options.srcRect) {
          ctx.drawImage(
            img,
            options.srcRect.x, options.srcRect.y, options.srcRect.width, options.srcRect.height,
            options.destRect.x, options.destRect.y, options.destRect.width, options.destRect.height
          );
        } else {
          ctx.drawImage(img, options.destRect.x, options.destRect.y, options.destRect.width, options.destRect.height);
        }

        ctx.restore();
        resolve();
      };
      img.onerror = () => reject(new Error("Failed to load image"));

      if (typeof options.image === "string") {
        img.src = options.image;
      } else {
        img.src = `data:image/${options.image.format};base64,${options.image.base64}`;
      }
    });
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

  // MARK: - Pixel Data

  async getPixelData(options: { canvasId: string; rect?: CanvasRect }): Promise<{
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    const rect = options.rect || {
      x: 0,
      y: 0,
      width: instance.element.width,
      height: instance.element.height,
    };

    const imageData = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    return {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    };
  }

  // MARK: - Export

  async toImage(options: {
    canvasId: string;
    format?: "png" | "jpeg" | "webp";
    quality?: number;
    layerIds?: string[];
  }): Promise<CanvasImageData> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const format = options.format || "png";
    const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
    const quality = options.quality !== undefined ? options.quality / 100 : 0.92;

    const dataUrl = instance.element.toDataURL(mimeType, quality);
    const base64 = dataUrl.split(",")[1];

    return {
      base64,
      format,
      width: instance.element.width,
      height: instance.element.height,
    };
  }

  // MARK: - Transform

  async setTransform(options: { canvasId: string; transform: CanvasTransform }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    const ctx = instance.context;
    ctx.resetTransform();
    this.applyTransform(ctx, options.transform);
  }

  async resetTransform(options: { canvasId: string }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    instance.context.resetTransform();
  }

  // MARK: - Touch Input

  async setTouchEnabled(options: { canvasId: string; enabled: boolean }): Promise<void> {
    const instance = this.canvases.get(options.canvasId);
    if (!instance) {
      throw new Error(`Canvas not found: ${options.canvasId}`);
    }

    instance.touchEnabled = options.enabled;

    if (options.enabled) {
      this.setupTouchListeners(instance);
    } else {
      this.removeTouchListeners(instance);
    }
  }

  private setupTouchListeners(instance: CanvasInstance): void {
    const canvas = instance.element;

    const createTouchEvent = (e: TouchEvent, type: "start" | "move" | "end" | "cancel"): CanvasTouchEvent => {
      const rect = canvas.getBoundingClientRect();
      const touches = Array.from(e.touches).map((t) => ({
        id: t.identifier,
        x: t.clientX - rect.left,
        y: t.clientY - rect.top,
        force: t.force,
      }));
      return { type, touches, timestamp: Date.now() };
    };

    const handlers = {
      touchstart: (e: TouchEvent) => {
        e.preventDefault();
        this.notifyListeners("touch", createTouchEvent(e, "start"));
      },
      touchmove: (e: TouchEvent) => {
        e.preventDefault();
        this.notifyListeners("touch", createTouchEvent(e, "move"));
      },
      touchend: (e: TouchEvent) => {
        e.preventDefault();
        this.notifyListeners("touch", createTouchEvent(e, "end"));
      },
      touchcancel: (e: TouchEvent) => {
        e.preventDefault();
        this.notifyListeners("touch", createTouchEvent(e, "cancel"));
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      canvas.addEventListener(event, handler as EventListener);
    }

    // Store handlers for removal
    (canvas as HTMLCanvasElement & { _touchHandlers?: typeof handlers })._touchHandlers = handlers;
  }

  private removeTouchListeners(instance: CanvasInstance): void {
    const canvas = instance.element as HTMLCanvasElement & { _touchHandlers?: Record<string, EventListener> };
    const handlers = canvas._touchHandlers;
    if (handlers) {
      for (const [event, handler] of Object.entries(handlers)) {
        canvas.removeEventListener(event, handler);
      }
      delete canvas._touchHandlers;
    }
  }

  // MARK: - Event Listeners

  private notifyListeners<T>(eventName: string, data: T): void {
    for (const listener of this.listeners) {
      if (listener.eventName === eventName) {
        (listener.callback as EventCallback<T>)(data);
      }
    }
  }

  async addListener(
    eventName: "touch",
    listenerFunc: (event: CanvasTouchEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: "render",
    listenerFunc: (event: CanvasRenderEvent) => void
  ): Promise<PluginListenerHandle>;
  async addListener(
    eventName: string,
    listenerFunc: EventCallback<CanvasEvent>
  ): Promise<PluginListenerHandle> {
    const entry: ListenerEntry = { eventName, callback: listenerFunc };
    this.listeners.push(entry);

    return {
      remove: async () => {
        const idx = this.listeners.indexOf(entry);
        if (idx >= 0) {
          this.listeners.splice(idx, 1);
        }
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    this.listeners = [];
  }
}

// Export the plugin instance
export const Canvas = new CanvasElectron();
