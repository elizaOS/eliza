import path from "node:path";
import * as esbuild from "esbuild";
import {
  type CapabilityBroker,
  getCapabilityBroker,
} from "./capability-broker.ts";
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
  /**
   * Capability broker consulted before esbuild reads the entry and writes
   * the output. Defaults to the shared `getCapabilityBroker()` singleton.
   * Tests inject a broker pinned to a tmp state-dir.
   */
  broker?: CapabilityBroker;
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
      broker,
    } = options;

    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("PluginCompiler.compile: `entry` is required");
    }

    const resolvedOut = outFile ?? defaultOutFile(entry);

    // Compile is its own privileged operation: it ingests untrusted source
    // and emits an executable bundle. Broker the entry-read and out-write
    // explicitly so audit trails distinguish "compile this" from generic
    // VFS file access by the same project.
    const activeBroker = broker ?? getCapabilityBroker();
    const entryDecision = activeBroker.check({
      kind: "fs",
      op: "read",
      target: vfsTarget(vfs, entry),
      toolName: "plugin-compiler.compile",
    });
    if (entryDecision.allowed !== true) {
      throw new Error(
        `[plugin-compiler] capability denied: ${entryDecision.reason}`,
      );
    }
    const outDecision = activeBroker.check({
      kind: "fs",
      op: "write",
      target: vfsTarget(vfs, resolvedOut),
      toolName: "plugin-compiler.compile",
    });
    if (outDecision.allowed !== true) {
      throw new Error(
        `[plugin-compiler] capability denied: ${outDecision.reason}`,
      );
    }

    const entrySource = await vfs.readFile(entry);
    const entryDiskPath = vfs.resolveDiskPath(entry);
    const outDiskPath = vfs.resolveDiskPath(resolvedOut);

    const loader = inferLoader(entry);

    const start = Date.now();
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

    const durationMs = Date.now() - start;

    if (!result.outputFiles || result.outputFiles.length === 0) {
      throw new Error(
        "PluginCompiler.compile: esbuild produced no output files",
      );
    }

    const primary = result.outputFiles[0];
    if (!primary) {
      throw new Error("PluginCompiler.compile: esbuild produced no output");
    }

    await vfs.writeFile(resolvedOut, primary.contents);

    void outDiskPath;

    return {
      outFile: vfs.resolveVirtualPath(resolvedOut),
      format,
      target,
      warnings: result.warnings,
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

function vfsTarget(vfs: VirtualFilesystemService, virtualPath: string): string {
  const normalized = virtualPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `vfs://${vfs.projectId}/${normalized}`;
}

function defaultOutFile(entry: string): string {
  const normalized = entry.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  const last = segments[segments.length - 1];
  if (!last) {
    throw new Error(`Cannot derive output filename from entry: ${entry}`);
  }
  const stem = last.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, "");
  return `dist/${stem}.js`;
}
