/**
 * Consumer-bundle probe for #18702: bundles the plugin's browser entrypoint
 * with the same production Bun.build settings as `build.ts` (browser target,
 * ESM, package.json-derived externals; unminified so identifiers stay
 * observable) without writing `dist/`, imports core's real browser entry
 * source, and prints the module-graph facts the regression test asserts on.
 * Run with bun from the plugin root; output is one JSON object on stdout.
 */
import { externalsFromPackageJson } from "../../../plugin-build-externals";

const pluginRoot = new URL("../..", import.meta.url).pathname;
process.chdir(pluginRoot);

const external = await externalsFromPackageJson("./package.json");
const result = await Bun.build({
  entrypoints: ["index.browser.ts"],
  target: "browser",
  format: "esm",
  external,
});

if (!result.success) {
  console.log(JSON.stringify({ success: false, logs: result.logs.map((l) => String(l)) }));
  process.exit(0);
}

const text = await result.outputs[0].text();
const core = await import("../../../../packages/core/src/index.browser.ts");

console.log(
  JSON.stringify({
    success: true,
    hasCoreNodeSubpath: text.includes("@elizaos/core/node"),
    nodeBuiltins: [...new Set([...text.matchAll(/["'](node:[a-z0-9/_-]+)["']/g)].map((m) => m[1]))],
    registersBrowserFetcher: text.includes("installBrowserTranscriptionUrlFetcher"),
    registersNodeFetcher: text.includes("installNodeTranscriptionUrlFetcher"),
    coreBrowserExports: {
      isBlockedHostname: typeof core.isBlockedHostname,
      isPrivateIpAddress: typeof core.isPrivateIpAddress,
      SsrfBlockedError: typeof core.SsrfBlockedError,
    },
  })
);
