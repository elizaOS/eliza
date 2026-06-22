/**
 * Minimal ambient type for Vite's `import.meta.glob`, used by the
 * portable-stories smoke tests (`*-stories-smoke.test.tsx`) to discover every
 * `*.stories.tsx` in a directory. We declare just this method rather than
 * referencing the whole `vite/client` types to avoid pulling Vite's CSS/asset
 * module + `import.meta.env`/`hot` globals into the package's type graph.
 */
interface ImportMeta {
  glob<T = Record<string, unknown>>(
    pattern: string | string[],
    options?: { eager?: boolean; import?: string; query?: string },
  ): Record<string, T>;
}
