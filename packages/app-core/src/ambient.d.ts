/// <reference types="vite/client" />

/**
 * Ambient type declarations for @elizaos/app-core.
 *
 * Provides Vite `import.meta.env` types for modules that use env vars.
 */

interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly VITE_ENABLE_COMPANION_MODE?: string;
    readonly VITE_ENABLE_MEMORY_MONITOR?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
