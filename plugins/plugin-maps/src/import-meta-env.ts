/**
 * Vite-style `import.meta.env` visibility for the `@elizaos/ui` sources this
 * package type-checks through its tsconfig path mapping. Type-only global
 * augmentation; the runtime plugin itself never reads `import.meta.env`.
 * A plain module rather than a declaration file because plugin src trees
 * gitignore generated `.d.ts` outputs.
 */

declare global {
  interface ImportMetaEnv {
    readonly [key: string]: string | boolean | undefined;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
