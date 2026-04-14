declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "electrobun/view" {
  type WebviewEventHandler = (...args: unknown[]) => void;

  export interface WebviewTagElement extends HTMLElement {
    src: string;
    partition: string;
    loadURL(url: string): void;
    on(event: string, handler: WebviewEventHandler): void;
    off(event: string, handler: WebviewEventHandler): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    canGoBack(): boolean | Promise<boolean>;
    canGoForward(): boolean | Promise<boolean>;
  }
}

declare module "@elizaos/plugin-groq" {
  const groqPlugin: unknown;
  export default groqPlugin;
}

declare module "@elizaos/plugin-edge-tts";
declare module "@elizaos/plugin-edge-tts/node";

interface ImportMetaEnv {
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly [key: string]: string | boolean | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
