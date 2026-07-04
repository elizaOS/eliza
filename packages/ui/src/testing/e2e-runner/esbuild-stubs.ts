/**
 * esbuild resolve/load plugins the `__e2e__` fixture runners share to bundle a
 * shell fixture for the browser. The overlay's import graph transitively reaches
 * server-only code — the API-touching `usePromptSuggestions` hook, `@elizaos/core`
 * module-init that touches `process` + node builtins — which is dead at render in
 * a headless page. Production Vite resolves core's `browser` export condition and
 * a real API; a raw esbuild bundle does not, so these three plugins replace those
 * edges with no-op proxies / a local stub.
 *
 * Type-only esbuild import: importing these factories pulls no runtime esbuild, so
 * the frame-glitch harness (which resolves esbuild itself) can share them too.
 */

import { builtinModules } from "node:module";
import type { Plugin } from "esbuild";

/** Redirect the API-backed prompt-suggestions hook to a local no-op stub. */
export function stubPromptSuggestions(stubPath: string): Plugin {
  return {
    name: "stub-prompt-suggestions",
    setup(build) {
      build.onResolve({ filter: /usePromptSuggestions$/ }, () => ({
        path: stubPath,
      }));
    },
  };
}

/**
 * Replace `@elizaos/core` with a no-op Proxy that answers the render-path symbols
 * the shell reads (`isViewVisible`, `dedupeModalities`, `findInteractionRegions`)
 * and proxies everything else, so core's Node graph is never bundled.
 */
export function stubElizaCore(): Plugin {
  return {
    name: "stub-eliza-core",
    setup(build) {
      build.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
        path: args.path,
        namespace: "eliza-core-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
        contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            isViewVisible: () => true,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            findInteractionRegions: () => [],
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
        loader: "js",
      }));
    },
  };
}

/** Replace every node builtin (dead in the browser) with a no-op proxy module. */
export function stubNodeBuiltins(): Plugin {
  const nodeBuiltins = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ]);
  return {
    name: "stub-node-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const bare = args.path.replace(/^node:/, "").split("/")[0] ?? "";
        if (
          args.path.startsWith("node:") ||
          nodeBuiltins.has(args.path) ||
          builtinModules.includes(bare)
        ) {
          return { path: args.path, namespace: "node-stub" };
        }
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
        contents:
          "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
        loader: "js",
      }));
    },
  };
}
