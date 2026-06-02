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

function isKnownToleratedViewBundleWarning(message: unknown): boolean {
  const text =
    typeof message === "string"
      ? message
      : [
          (message as { code?: unknown })?.code,
          (message as { message?: unknown })?.message,
          (message as { id?: unknown })?.id,
        ]
          .filter((value): value is string => typeof value === "string")
          .join("\n");

  return (
    text.includes("IMPORT_IS_UNDEFINED") &&
    text.includes("Import `tslFn`") &&
    text.includes("three.webgpu")
  );
}

export function createViewBundleConfig(options: ViewBundleOptions): UserConfig {
  const outDir = options.outDir ?? "dist/views";
  const externals = new Set([
    options.packageName,
    "@elizaos/app-core",
    "@elizaos/shared",
    "@elizaos/ui",
    "lucide-react",
    "react",
    "react-plaid-link",
    "react/jsx-dev-runtime",
    "react/jsx-runtime",
    ...(options.additionalExternals ?? []),
  ]);

  return defineConfig({
    build: {
      emptyOutDir: false,
      outDir,
      sourcemap: true,
      chunkSizeWarningLimit: 4000,
      lib: {
        entry: path.resolve(process.cwd(), options.entry),
        formats: ["es"],
        fileName: () => "bundle.js",
      },
      rollupOptions: {
        external: (id) =>
          externals.has(id) ||
          [...externals].some((external) => id.startsWith(`${external}/`)),
        onwarn(warning, warn) {
          if (isKnownToleratedViewBundleWarning(warning)) {
            return;
          }
          warn(warning);
        },
        output: {
          exports: "named",
        },
      },
    },
    define: {
      "import.meta.env.DEV": JSON.stringify(false),
      "import.meta.env.PROD": JSON.stringify(true),
      "import.meta.env.MODE": JSON.stringify(
        process.env.NODE_ENV ?? "production",
      ),
      "import.meta.env.SSR": JSON.stringify(false),
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV ?? "production",
      ),
      __ELIZA_VIEW_ID__: JSON.stringify(options.viewId),
      __ELIZA_VIEW_EXPORT__: JSON.stringify(
        options.componentExport ?? "default",
      ),
    },
  });
}
