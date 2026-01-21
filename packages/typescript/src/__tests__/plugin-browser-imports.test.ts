import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as vm from "node:vm";

import { build } from "esbuild";
import { glob } from "glob";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const AllowlistSchema = z.record(z.string(), z.object({ reason: z.string() }));
type Allowlist = z.infer<typeof AllowlistSchema>;

function getRepoRoot(): string {
  // packages/typescript/src/__tests__/ -> repo root
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

function getPluginNameFromEntry(entryAbsPath: string): string {
  const parts = entryAbsPath.split(path.sep);
  const pluginsIdx = parts.lastIndexOf("plugins");
  if (pluginsIdx === -1 || pluginsIdx + 1 >= parts.length) {
    return entryAbsPath;
  }
  return parts[pluginsIdx + 1] ?? entryAbsPath;
}

async function readAllowlist(repoRoot: string): Promise<Allowlist> {
  const allowlistPath = path.join(
    repoRoot,
    "plugins",
    "browser-compat.allowlist.json",
  );
  if (!existsSync(allowlistPath)) {
    return {};
  }

  const raw = await readFile(allowlistPath, "utf8");
  return AllowlistSchema.parse(JSON.parse(raw));
}

async function bundleBrowserEntry(entryAbsPath: string): Promise<string> {
  const result = await build({
    entryPoints: [entryAbsPath],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "__elizaPluginBrowserImport",
    target: ["es2022"],
    sourcemap: false,
    logLevel: "silent",
    // IMPORTANT:
    // The repo root tsconfig.json maps "@elizaos/core" -> src/index.node.ts via "paths".
    // For a *browser* import check we must ignore those path mappings and use normal
    // package resolution ("exports"/"browser" conditions), otherwise we accidentally
    // bundle Node-only source code and get false failures.
    tsconfigRaw: {
      compilerOptions: {
        paths: {},
      },
    },
  });

  const first = result.outputFiles[0];
  if (!first) {
    throw new Error("Bundler produced no output");
  }

  return first.text;
}

async function evaluateAsBrowserModule(
  code: string,
  url: string,
): Promise<void> {
  const readableStream =
    typeof ReadableStream === "undefined" ? undefined : ReadableStream;
  const writableStream =
    typeof WritableStream === "undefined" ? undefined : WritableStream;
  const transformStream =
    typeof TransformStream === "undefined" ? undefined : TransformStream;
  const cryptoValue = typeof crypto === "undefined" ? undefined : crypto;

  const sandbox = {
    console,
    fetch,
    setTimeout,
    clearTimeout,
    // JSON exists in real browsers; include it in the sandbox to match that reality.
    JSON,
    TextEncoder,
    TextDecoder,
    URL,
    ReadableStream: readableStream,
    WritableStream: writableStream,
    TransformStream: transformStream,
    crypto: cryptoValue,
  };

  // Common browser-ish globals (no `process`).
  Reflect.set(sandbox, "globalThis", sandbox);
  Reflect.set(sandbox, "window", sandbox);
  Reflect.set(sandbox, "self", sandbox);
  vm.runInNewContext(code, sandbox, { filename: url, displayErrors: true });
}

describe("plugins: browser import compatibility", () => {
  test("all plugins are either browser-importable or explicitly allowlisted", async () => {
    const repoRoot = getRepoRoot();
    const allowlist = await readAllowlist(repoRoot);

    const pluginPkgs = await glob("plugins/*/typescript/package.json", {
      cwd: repoRoot,
      absolute: true,
    });

    // This test is meant to stay on as a regression guard.
    expect(pluginPkgs.length).toBeGreaterThan(0);

    const failures: Array<{ plugin: string; entry: string; error: string }> =
      [];
    const allowlisted: Array<{
      plugin: string;
      reason: string;
      error: string;
    }> = [];

    for (const pkgAbsPath of pluginPkgs) {
      const plugin = getPluginNameFromEntry(pkgAbsPath);
      const allowReason = allowlist[plugin]?.reason;

      const pkgDir = path.dirname(pkgAbsPath);
      const indexBrowserTs = path.join(pkgDir, "index.browser.ts");
      const hasIndexBrowserTs = existsSync(indexBrowserTs);

      try {
        if (!hasIndexBrowserTs) {
          // 100% coverage: every plugin must either provide a browser entrypoint OR be allowlisted.
          throw new Error(
            "Missing browser entrypoint: expected plugins/<plugin>/typescript/index.browser.ts",
          );
        }

        const code = await bundleBrowserEntry(indexBrowserTs);
        await evaluateAsBrowserModule(code, `file://${indexBrowserTs}`);
      } catch (e) {
        const errorText =
          e instanceof Error ? (e.stack ?? e.message) : String(e);
        if (allowReason) {
          allowlisted.push({
            plugin,
            reason: allowReason,
            error: errorText,
          });
        } else {
          failures.push({ plugin, entry: indexBrowserTs, error: errorText });
        }
      }
    }

    if (allowlisted.length > 0) {
      for (const item of allowlisted) {
        // Intentional: keep a visible warning trail in CI output.
        // eslint-disable-next-line no-console
        console.warn(
          `[browser-import allowlisted] ${item.plugin}: ${item.reason}\n${item.error}\n`,
        );
      }
    }

    if (failures.length > 0) {
      const details = failures
        .map((f) => `- ${f.plugin}\n  entry: ${f.entry}\n  error: ${f.error}`)
        .join("\n\n");
      throw new Error(
        `Browser import failures (${failures.length}):\n\n${details}\n`,
      );
    }
  }, 60_000);
});
