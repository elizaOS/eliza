/**
 * Unit coverage for CLI terminal theme utilities in theme.ts.
 *
 * Tests theme color properties, cyberGreen color helper, isRich predicate,
 * conditional colorize helper, and the browser-import safety of the module
 * scope (no bare `process` read).
 */

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { colorize } from "./theme.js";

describe("terminal theme", () => {
  describe("colorize", () => {
    it("returns colored string when rich is true", () => {
      const mockFormatter = (val: string) => `[colored]${val}[/colored]`;
      const result = colorize(true, mockFormatter, "hello");
      expect(result).toBe("[colored]hello[/colored]");
    });

    it("returns plain string untouched when rich is false", () => {
      const mockFormatter = (val: string) => `[colored]${val}[/colored]`;
      const result = colorize(false, mockFormatter, "hello");
      expect(result).toBe("hello");
    });
  });

  describe("module scope without `process`", () => {
    /**
     * The shared barrel reaches this module from browser bundles (e.g. the
     * permission-priming e2e graph, which esbuild-bundles for the browser
     * and defines only `process.env.NODE_ENV`). Reading `process.env` at
     * module scope threw ReferenceError there, killing the whole graph
     * before any consumer mounted. Replay the browser condition
     * faithfully: bundle for the browser (no node builtins, no defines)
     * and evaluate inside a vm context with NO `process` global at all.
     */
    it("evaluates the browser bundle without throwing in a process-less context", async () => {
      const out = join(tmpdir(), `eliza-theme-browser-${Date.now()}.js`);
      await build({
        entryPoints: [new URL("./theme.ts", import.meta.url).pathname],
        bundle: true,
        format: "iife",
        globalName: "__themeBundle",
        platform: "browser",
        // No `define` at all: bare `process` identifiers must survive to
        // runtime, exactly like the e2e runner's browser bundle.
        outfile: out,
        logLevel: "silent",
      });
      const code = await readFile(out, "utf8");
      const context: Record<string, unknown> = {}; // no `process` global
      vm.runInNewContext(code, context);
      const bundle = context.__themeBundle as { theme: unknown };
      expect(bundle).toBeDefined();
      expect(bundle.theme).toBeTypeOf("object");
    });
  });
});
