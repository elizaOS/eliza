/** Bundle the production service and Capacitor library for the isolated Android WebView fixture. */

import { readFileSync } from "node:fs";
import path from "node:path";

const outfile = process.argv[2];
if (!outfile) throw new Error("Expected output bundle path");
const result = await Bun.build({
  entrypoints: [path.join(import.meta.dirname, "browser-contract.ts")],
  target: "browser",
  define: { global: "globalThis" },
  format: "iife",
  plugins: [
    {
      name: "real-core-leaves",
      setup(build) {
        build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
          path: path.join(import.meta.dirname, "core-browser-exports.ts"),
        }));
      },
    },
  ],
});
if (!result.success)
  throw new AggregateError(result.logs, "Filesystem WebView build failed");
if (result.outputs.length !== 1)
  throw new Error("Expected one self-contained browser bundle");
// Reuse the renderer's actual synchronous Node compatibility bootstrap.
const html = readFileSync(
  path.join(import.meta.dirname, "../../index.html"),
  "utf8",
);
const bootstraps = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter((script) =>
    script.includes('typeof globalThis.process === "undefined"'),
  );
if (bootstraps.length !== 1)
  throw new Error("Expected the renderer's process/Buffer bootstrap");
await Bun.write(outfile, `${bootstraps[0]}\n${await result.outputs[0].text()}`);
