import path from "node:path";
import * as esbuild from "esbuild";
import type { VirtualFilesystemService } from "./virtual-filesystem.ts";

export type PluginCompilerFormat = "esm" | "cjs";

export interface PluginCompilerOptions {
  vfs: VirtualFilesystemService;
  /**
   * Project id is informational; the VFS instance already binds to a project,
   * but callers commonly carry the id alongside and we record it for logging.
   */
  projectId?: string;
  /** Virtual entry path inside the VFS, e.g. `src/plugin.ts`. */
  entry: string;
  /** Virtual output path inside the VFS. Defaults to `dist/<entry-stem>.js`. */
  outFile?: string;
  format?: PluginCompilerFormat;
  target?: string;
  /**
   * Patterns excluded from bundling. Defaults to ["@elizaos/*"] so the
   * compiled plugin resolves elizaOS peers from the host runtime rather than
   * inlining them.
   */
  external?: string[];
  /** When true (default), inline a sourcemap into the output. */
  sourcemap?: boolean;
  /** When true (default), bundle dependencies. */
  bundle?: boolean;
  /** When false, suppress esbuild's default minification. Default false. */
  minify?: boolean;
}

export interface PluginCompilerResult {
  outFile: string;
  format: PluginCompilerFormat;
  target: string;
  warnings: esbuild.Message[];
  durationMs: number;
}

const DEFAULT_TARGET = "node20";
const DEFAULT_EXTERNAL = ["@elizaos/*"];

/**
 * Compiles TypeScript plugin source from a project's VFS into JS, also written
 * to the same VFS. The output is a real on-disk file that can be loaded via
 * dynamic `import(pathToFileURL(...))`.
 *
 * Path-traversal protection is delegated to the VFS: every path that enters
 * this compiler goes through `vfs.readFile` / `vfs.writeFile` /
 * `vfs.resolveDiskPath`, which reject any path that would escape the project
 * root.
 */
export class PluginCompiler {
  async compile(options: PluginCompilerOptions): Promise<PluginCompilerResult> {
    const {
      vfs,
      entry,
      outFile,
      format = "esm",
      target = DEFAULT_TARGET,
      external = DEFAULT_EXTERNAL,
      sourcemap = true,
      bundle = true,
      minify = false,
    } = options;

    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("PluginCompiler.compile: `entry` is required");
    }

    const resolvedOut = outFile ?? defaultOutFile(entry);
    const entrySource = await vfs.readFile(entry);
    const entryDiskPath = vfs.resolveDiskPath(entry);
    const outDiskPath = vfs.resolveDiskPath(resolvedOut);

    const loader = inferLoader(entry);

    const start = Date.now();
    let warnings: esbuild.Message[] = [];
    let output: string | Uint8Array;

    try {
      const result = await esbuild.build({
        stdin: {
          contents: entrySource,
          resolveDir: path.dirname(entryDiskPath),
          sourcefile: path.basename(entryDiskPath),
          loader,
        },
        bundle,
        write: false,
        format,
        target,
        platform: "node",
        external: [...external],
        sourcemap: sourcemap ? "inline" : false,
        minify,
        logLevel: "silent",
      });

      if (!result.outputFiles || result.outputFiles.length === 0) {
        throw new Error(
          "PluginCompiler.compile: esbuild produced no output files",
        );
      }

      const primary = result.outputFiles[0];
      if (!primary) {
        throw new Error("PluginCompiler.compile: esbuild produced no output");
      }

      warnings = result.warnings;
      output = primary.contents;
    } catch (error) {
      if (!isEsbuildServiceStoppedError(error)) {
        throw error;
      }
      output = transpileWithBun(entrySource, loader);
    }

    const durationMs = Date.now() - start;

    await vfs.writeFile(resolvedOut, output);

    void outDiskPath;

    return {
      outFile: vfs.resolveVirtualPath(resolvedOut),
      format,
      target,
      warnings,
      durationMs,
    };
  }
}

export function createPluginCompiler(): PluginCompiler {
  return new PluginCompiler();
}

function inferLoader(entry: string): esbuild.Loader {
  const ext = path.extname(entry).toLowerCase();
  switch (ext) {
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".mjs":
    case ".cjs":
    case ".js":
      return "js";
    default:
      return "ts";
  }
}

function defaultOutFile(entry: string): string {
  const normalized = entry.replace(/\\/g, "/").replace(/^\/+/, "");
  const stem = normalized
    .split("/")
    .pop()
    ?.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, "");
  return `dist/${stem}.js`;
}

function isEsbuildServiceStoppedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /service (?:was stopped|is no longer running)/i.test(message);
}

function transpileWithBun(entrySource: string, loader: esbuild.Loader): string {
  const bunGlobal = globalThis as typeof globalThis & {
    Bun?: {
      Transpiler?: new (options: {
        loader: "js" | "jsx" | "ts" | "tsx";
        target?: "browser" | "bun" | "node";
      }) => { transformSync(source: string): string };
    };
  };
  const Transpiler = bunGlobal.Bun?.Transpiler;
  if (!Transpiler) {
    throw new Error(
      "PluginCompiler.compile: esbuild service stopped and Bun.Transpiler is unavailable",
    );
  }

  const transpiler = new Transpiler({
    loader: toBunLoader(loader),
    target: "node",
  });
  return transpiler.transformSync(entrySource);
}

function toBunLoader(loader: esbuild.Loader): "js" | "jsx" | "ts" | "tsx" {
  switch (loader) {
    case "tsx":
      return "tsx";
    case "jsx":
      return "jsx";
    case "js":
      return "js";
    default:
      return "ts";
  }
}
