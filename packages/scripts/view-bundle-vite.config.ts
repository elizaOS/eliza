import path from "node:path";
import { defineConfig, type UserConfig } from "vite";

type ViewBundleOptions = {
  packageName: string;
  viewId: string;
  entry: string;
  outDir?: string;
  componentExport?: string;
  additionalExternals?: string[];
};

export function createViewBundleConfig(options: ViewBundleOptions): UserConfig {
  const outDir = options.outDir ?? "dist/views";
  const externals = new Set([
    options.packageName,
    "@elizaos/app-core",
    "@elizaos/shared",
    "@elizaos/ui",
    ...(options.additionalExternals ?? []),
  ]);

  return defineConfig({
    build: {
      emptyOutDir: false,
      outDir,
      sourcemap: true,
      lib: {
        entry: path.resolve(process.cwd(), options.entry),
        formats: ["es"],
        fileName: () => "bundle.js",
      },
      rollupOptions: {
        external: (id) =>
          externals.has(id) ||
          [...externals].some((external) => id.startsWith(`${external}/`)),
        output: {
          exports: "named",
        },
      },
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV ?? "production",
      ),
      __ELIZA_VIEW_ID__: JSON.stringify(options.viewId),
      __ELIZA_VIEW_EXPORT__: JSON.stringify(options.componentExport ?? "default"),
    },
  });
}
