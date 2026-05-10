declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "electrobun/view" {
  type WebviewEventHandler = (event: CustomEvent) => void;

  export interface WebviewTagElement extends HTMLElement {
    src: string;
    html: string | null;
    preload: string | null;
    partition: string | null;
    hidden: boolean;
    transparent: boolean;
    passthroughEnabled: boolean;
    webviewId?: number;
    loadURL(url: string): void;
    loadHTML(html: string): void;
    on(event: string, handler: WebviewEventHandler): void;
    off(event: string, handler: WebviewEventHandler): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    canGoBack(): boolean | Promise<boolean>;
    canGoForward(): boolean | Promise<boolean>;
    toggleHidden(value?: boolean, bypassState?: boolean): void;
    toggleTransparent(value?: boolean, bypassState?: boolean): void;
    togglePassthrough(value?: boolean, bypassState?: boolean): void;
    setNavigationRules(rules: string[]): void;
    executeJavascript(js: string): void;
    syncDimensions(force?: boolean): void;
    findInPage(
      searchText: string,
      options?: { forward?: boolean; matchCase?: boolean },
    ): void;
    stopFindInPage(): void;
    openDevTools(): void;
    closeDevTools(): void;
    toggleDevTools(): void;
  }
}

declare module "@elizaos/plugin-groq" {
  const groqPlugin: unknown;
  export default groqPlugin;
}

declare module "@elizaos/plugin-edge-tts";
declare module "@elizaos/signal-native";

declare module "three/examples/jsm/libs/meshopt_decoder.module.js" {
  export const MeshoptDecoder: {
    supported: boolean;
    ready: Promise<void>;
    decode(
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode?: number,
    ): void;
    decodeGltfBuffer(
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode: string,
      filter?: string,
    ): void;
    useWorkers?(count: number): void;
  };
}

declare module "jsdom" {
  export class JSDOM {
    constructor(
      html?: string,
      options?: {
        url?: string;
        pretendToBeVisual?: boolean;
        [key: string]: unknown;
      },
    );
    window: Window & typeof globalThis;
    serialize(): string;
  }
}

/** WebGPU Navigator extension (not yet in all lib.dom versions) */
declare global {
  interface Navigator {
    gpu?: unknown;
  }
  /** WebXR frame type used by Three.js animation loop */
  interface XRFrame {}
}

interface ImportMetaEnv {
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
