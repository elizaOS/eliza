/**
 * Ambient type declarations for @elizaos/app-core.
 *
 * Provides Vite `import.meta.env` types for modules that use env vars.
 * Augments Window with Eliza injectables (Electron/Capacitor).
 */

declare global {
  interface GlobalThis {
    __ELIZA_API_BASE__?: string;
    __ELIZA_API_TOKEN__?: string;
  }

  interface Window {
    __ELIZA_API_BASE__?: string;
    __ELIZA_API_TOKEN__?: string;
  }
}

declare const __ELIZA_API_BASE__: string | undefined;
declare const __ELIZA_API_TOKEN__: string | undefined;

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_ENABLE_COMPANION_MODE?: string;
  readonly VITE_ENABLE_MEMORY_MONITOR?: string;
  readonly VITE_E2E_DISABLE_VRM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
