/** Implements Electrobun desktop vitest electrobun behavior for app-core shell integration. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCoreSrcRoot = path.resolve(__dirname, "../../src");
const remotePluginSrcRoot = path.resolve(
  __dirname,
  "../../../plugin-remote-manifest/src",
);
const sharedSrcRoot = path.resolve(__dirname, "../../../shared/src");
const coreSrcRoot = path.resolve(__dirname, "../../../core/src");
const loggerSrcRoot = path.resolve(__dirname, "../../../logger/src");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(coreSrcRoot, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.*)$/,
        replacement: path.join(coreSrcRoot, "$1"),
      },
      {
        find: /^@elizaos\/logger$/,
        replacement: path.join(loggerSrcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/logger\/(.*)$/,
        replacement: path.join(loggerSrcRoot, "$1"),
      },
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.join(appCoreSrcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.*)$/,
        replacement: path.join(appCoreSrcRoot, "$1"),
      },
      {
        find: /^@elizaos\/plugin-remote-manifest$/,
        replacement: path.join(remotePluginSrcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-remote-manifest\/(.*)$/,
        replacement: path.join(remotePluginSrcRoot, "$1"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(sharedSrcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.*)$/,
        replacement: path.join(sharedSrcRoot, "$1"),
      },
      {
        find: /^bun:ffi$/,
        replacement: path.resolve(__dirname, "src/__stubs__/bun-ffi.ts"),
      },
      {
        find: /^electrobun\/bun$/,
        replacement: path.resolve(__dirname, "src/__stubs__/electrobun-bun.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
