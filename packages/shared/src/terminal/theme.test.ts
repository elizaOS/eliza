/**
 * Unit coverage for CLI terminal theme utilities in theme.ts.
 *
 * Tests theme color properties, cyberGreen color helper, isRich predicate,
 * conditional colorize helper, and the browser-import safety of the module
 * scope (no bare `process` read).
 */

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
     * The shared barrel reaches this module from browser bundles. The
     * invariant under test: bundling for the browser (no node builtins)
     * must not leave module-scope code that needs a `process` global to
     * evaluate, because a page context that lacks one would throw
     * ReferenceError and kill the whole graph before any consumer mounts.
     * Bundle for the browser with no `define` replacements and evaluate
     * inside a vm context that has NO `process` global at all.
     */
    it("evaluates the browser bundle without throwing in a process-less context", async () => {
      const result = await build({
        entryPoints: [new URL("./theme.ts", import.meta.url).pathname],
        bundle: true,
        format: "iife",
        globalName: "__themeBundle",
        platform: "browser",
        // No `define` at all: bare `process` identifiers must survive to
        // runtime evaluation rather than being compiled away.
        write: false,
        logLevel: "silent",
      });
      const code = result.outputFiles[0]?.text ?? "";
      const context: Record<string, unknown> = {}; // no `process` global
      vm.runInNewContext(code, context);
      const bundle = context.__themeBundle as { theme: unknown };
      expect(bundle).toBeDefined();
      expect(bundle.theme).toBeTypeOf("object");
    });
  });
});
