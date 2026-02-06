import type { PluginListenerHandle } from "@capacitor/core";

export interface CanvasSize {
  width: number;
  height: number;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface CanvasStrokeStyle {
  color: CanvasColor | string;
  width: number;
  lineCap?: "butt" | "round" | "square";
  lineJoin?: "miter" | "round" | "bevel";
  dashPattern?: number[];
}

export interface CanvasFillStyle {
  color: CanvasColor | string;
}

export interface CanvasTextStyle {
  font: string;
  size: number;
  color: CanvasColor | string;
  align?: "left" | "center" | "right";
  baseline?: "top" | "middle" | "bottom" | "alphabetic";
  maxWidth?: number;
}

export interface CanvasShadow {
  color: CanvasColor | string;
  blur: number;
  offsetX: number;
  offsetY: number;
}

export interface CanvasGradientStop {
  offset: number;
  color: CanvasColor | string;
}

export interface CanvasLinearGradient {
  type: "linear";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: CanvasGradientStop[];
}

export interface CanvasRadialGradient {
  type: "radial";
  x0: number;
  y0: number;
  r0: number;
  x1: number;
  y1: number;
  r1: number;
  stops: CanvasGradientStop[];
}

export type CanvasGradient = CanvasLinearGradient | CanvasRadialGradient;

export interface CanvasLayer {
  id: string;
  name?: string;
  visible: boolean;
  opacity: number;
  zIndex: number;
  transform?: CanvasTransform;
}

export interface CanvasTransform {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  skewX?: number;
  skewY?: number;
}

export interface CanvasImageData {
  base64: string;
  format: "png" | "jpeg" | "webp";
  width: number;
  height: number;
}

export interface CanvasDrawPathCommand {
  type: "moveTo" | "lineTo" | "quadraticCurveTo" | "bezierCurveTo" | "arcTo" | "arc" | "ellipse" | "rect" | "closePath";
  args: number[];
}

export interface CanvasPath {
  commands: CanvasDrawPathCommand[];
}

export interface CanvasDrawOptions {
  layerId?: string;
  blendMode?: "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "color-dodge" | "color-burn";
  opacity?: number;
  shadow?: CanvasShadow;
  transform?: CanvasTransform;
}

export type CanvasDrawBatchCommand =
  | {
      type: "rect";
      args: {
        rect: CanvasRect;
        fill?: CanvasFillStyle | CanvasGradient;
        stroke?: CanvasStrokeStyle;
        cornerRadius?: number;
        drawOptions?: CanvasDrawOptions;
      };
    }
  | {
      type: "ellipse";
      args: {
        center: CanvasPoint;
        radiusX: number;
        radiusY: number;
        fill?: CanvasFillStyle | CanvasGradient;
        stroke?: CanvasStrokeStyle;
        drawOptions?: CanvasDrawOptions;
      };
    }
  | {
      type: "line";
      args: {
        from: CanvasPoint;
        to: CanvasPoint;
        stroke: CanvasStrokeStyle;
        drawOptions?: CanvasDrawOptions;
      };
    }
  | {
      type: "path";
      args: {
        path: CanvasPath;
        fill?: CanvasFillStyle | CanvasGradient;
        stroke?: CanvasStrokeStyle;
        drawOptions?: CanvasDrawOptions;
      };
    }
  | {
      type: "text";
      args: {
        text: string;
        position: CanvasPoint;
        style: CanvasTextStyle;
        drawOptions?: CanvasDrawOptions;
      };
    }
  | {
      type: "image";
      args: {
        image: CanvasImageData | string;
        destRect: CanvasRect;
        srcRect?: CanvasRect;
        drawOptions?: CanvasDrawOptions;
      };
    }
  | {
      type: "clear";
      args: {
        rect?: CanvasRect;
        layerId?: string;
      };
    };

export interface CanvasTouchEvent {
  type: "start" | "move" | "end" | "cancel";
  touches: Array<{
    id: number;
    x: number;
    y: number;
    force?: number;
  }>;
  timestamp: number;
}

export interface CanvasRenderEvent {
  timestamp: number;
  frameNumber: number;
  fps: number;
}

// ---- Web View Types ----

export type WebViewPlacement = "inline" | "fullscreen" | "popup";

export interface NavigateOptions {
  url: string;
  placement?: WebViewPlacement;
}

export interface EvalOptions {
  script: string;
}

export interface EvalResult {
  result: string;
}

export type SnapshotFormat = "png" | "jpeg" | "webp";

export interface SnapshotOptions {
  maxWidth?: number;
  quality?: number;
  format?: SnapshotFormat;
}

export interface SnapshotResult {
  base64: string;
  width: number;
  height: number;
  format: SnapshotFormat;
}

export interface A2UIMessage {
  role: "assistant" | "user" | "system";
  type: "text" | "card" | "action" | "form" | "list" | "image" | "status";
  content: string;
  id?: string;
  timestamp?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface A2UIPayload {
  action: string;
  data?: Record<string, string | number | boolean>;
}

export interface A2UIPushOptions {
  messages?: A2UIMessage[];
  jsonl?: string;
  payload?: A2UIPayload;
}

// ---- Web View Events ----

export interface WebViewReadyEvent {
  url: string;
  title: string;
}

export interface NavigationErrorEvent {
  url: string;
  code: number;
  message: string;
}

export interface DeepLinkEvent {
  url: string;
  path: string;
  params: Record<string, string>;
}

export interface A2UIActionEvent {
  action: string;
  data: Record<string, string | number | boolean>;
  messageId?: string;
}

export interface CanvasPlugin {
  /**
   * Create a new canvas with the specified size
   */
  create(options: { size: CanvasSize; backgroundColor?: CanvasColor | string }): Promise<{ canvasId: string }>;

  /**
   * Destroy a canvas and free resources
   */
  destroy(options: { canvasId: string }): Promise<void>;

  /**
   * Attach canvas to a DOM element
   */
  attach(options: { canvasId: string; element: HTMLElement }): Promise<void>;

  /**
   * Detach canvas from its DOM element
   */
  detach(options: { canvasId: string }): Promise<void>;

  /**
   * Resize the canvas
   */
  resize(options: { canvasId: string; size: CanvasSize }): Promise<void>;

  /**
   * Clear the entire canvas or a specific area
   */
  clear(options: { canvasId: string; rect?: CanvasRect; layerId?: string }): Promise<void>;

  /**
   * Create a new layer
   */
  createLayer(options: { canvasId: string; layer: Omit<CanvasLayer, "id"> }): Promise<{ layerId: string }>;

  /**
   * Update layer properties
   */
  updateLayer(options: { canvasId: string; layerId: string; layer: Partial<CanvasLayer> }): Promise<void>;

  /**
   * Delete a layer
   */
  deleteLayer(options: { canvasId: string; layerId: string }): Promise<void>;

  /**
   * Get all layers
   */
  getLayers(options: { canvasId: string }): Promise<{ layers: CanvasLayer[] }>;

  /**
   * Draw a rectangle
   */
  drawRect(options: {
    canvasId: string;
    rect: CanvasRect;
    fill?: CanvasFillStyle | CanvasGradient;
    stroke?: CanvasStrokeStyle;
    cornerRadius?: number;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void>;

  /**
   * Draw an ellipse
   */
  drawEllipse(options: {
    canvasId: string;
    center: CanvasPoint;
    radiusX: number;
    radiusY: number;
    fill?: CanvasFillStyle | CanvasGradient;
    stroke?: CanvasStrokeStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void>;

  /**
   * Draw a line
   */
  drawLine(options: {
    canvasId: string;
    from: CanvasPoint;
    to: CanvasPoint;
    stroke: CanvasStrokeStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void>;

  /**
   * Draw a path
   */
  drawPath(options: {
    canvasId: string;
    path: CanvasPath;
    fill?: CanvasFillStyle | CanvasGradient;
    stroke?: CanvasStrokeStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void>;

  /**
   * Draw text
   */
  drawText(options: {
    canvasId: string;
    text: string;
    position: CanvasPoint;
    style: CanvasTextStyle;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void>;

  /**
   * Draw an image
   */
  drawImage(options: {
    canvasId: string;
    image: CanvasImageData | string;
    destRect: CanvasRect;
    srcRect?: CanvasRect;
    drawOptions?: CanvasDrawOptions;
  }): Promise<void>;

  /**
   * Execute a batch of drawing commands
   */
  drawBatch(options: {
    canvasId: string;
    commands: CanvasDrawBatchCommand[];
  }): Promise<void>;

  /**
   * Get pixel data from the canvas
   */
  getPixelData(options: { canvasId: string; rect?: CanvasRect }): Promise<{
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }>;

  /**
   * Export the canvas to an image
   */
  toImage(options: {
    canvasId: string;
    format?: "png" | "jpeg" | "webp";
    quality?: number;
    layerIds?: string[];
  }): Promise<CanvasImageData>;

  /**
   * Set global canvas transform
   */
  setTransform(options: { canvasId: string; transform: CanvasTransform }): Promise<void>;

  /**
   * Reset global canvas transform
   */
  resetTransform(options: { canvasId: string }): Promise<void>;

  /**
   * Enable or disable touch input handling
   */
  setTouchEnabled(options: { canvasId: string; enabled: boolean }): Promise<void>;

  // ---- Web View Methods ----

  /**
   * Load a URL in a web view
   */
  navigate(options: NavigateOptions): Promise<void>;

  /**
   * Evaluate JavaScript in the web view and return the result as a string
   */
  eval(options: EvalOptions): Promise<EvalResult>;

  /**
   * Take a screenshot of the web view content
   */
  snapshot(options?: SnapshotOptions): Promise<SnapshotResult>;

  /**
   * Push A2UI messages to the web view
   */
  a2uiPush(options: A2UIPushOptions): Promise<void>;

  /**
   * Reset A2UI state in the web view
   */
  a2uiReset(): Promise<void>;

  // ---- Event Listeners ----

  /**
   * Add listener for touch events
   */
  addListener(
    eventName: "touch",
    listenerFunc: (event: CanvasTouchEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for render frame events
   */
  addListener(
    eventName: "render",
    listenerFunc: (event: CanvasRenderEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for web view ready events (fired when navigation completes)
   */
  addListener(
    eventName: "webViewReady",
    listenerFunc: (event: WebViewReadyEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for navigation error events
   */
  addListener(
    eventName: "navigationError",
    listenerFunc: (event: NavigationErrorEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for deep link events (milaidy:// URL intercepts)
   */
  addListener(
    eventName: "deepLink",
    listenerFunc: (event: DeepLinkEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Add listener for A2UI action events from web content
   */
  addListener(
    eventName: "a2uiAction",
    listenerFunc: (event: A2UIActionEvent) => void
  ): Promise<PluginListenerHandle>;

  /**
   * Remove all event listeners
   */
  removeAllListeners(): Promise<void>;
}
