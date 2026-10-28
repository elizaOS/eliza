/**
 * The Cloudflare Workers runtime rejects `fetch(..., { redirect: "error" })`
 * (and `new Request(..., { redirect: "error" })`) with
 * `TypeError: Invalid redirect value, must be one of "follow" or "manual"`, so a
 * module the API Worker bundles must never use that mode with a platform fetch
 * (elizaOS/eliza#37102). Never-follow requests use `"manual"` and refuse a 3xx
 * explicitly (`@elizaos/cloud-shared` `lib/utils/no-redirect-fetch`).
 *
 * The scan covers the Worker's real import graph — bundled from
 * `wrangler.toml`'s entry with its aliases and the workerd export conditions —
 * plus every non-test source file under the API and the shared library, so a
 * module that is not imported yet is caught before it is.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const cloudRoot = path.resolve(apiRoot, "..");
const sharedSrc = path.join(cloudRoot, "shared/src");

/**
 * `safeFetch` implements `redirect: "error"` itself (it always sends "manual"
 * to the platform and throws on a 3xx), so these calls are Worker-safe. Each
 * entry pins the exact count so a new raw-fetch use in the same file still fails.
 */
const SAFE_FETCH_ROUTED: Record<string, number> = {
  "api/mcp/proxy/[mcpId]/route.ts": 1, // safeFetch(targetUrl, …)
  "shared/src/lib/services/app-billing-notifications.ts": 1, // transport = safeFetch
  "shared/src/lib/services/app-promotion-assets.ts": 1, // safeFetch(safeUrl, …)
  "shared/src/lib/services/eliza-app/describe-inbound-media.ts": 1, // safeFetch(url, …)
  "shared/src/lib/services/seo.ts": 1, // seoFetch → safeFetch
};

const REDIRECT_ERROR = /\bredirect\s*:\s*(["'`])error\1/g;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:\.test\.|\.spec\.|\/__tests__\/|\/test\/|\/tests\/)/;

async function workerImportGraph(): Promise<string[]> {
  const config = Bun.TOML.parse(
    readFileSync(path.join(apiRoot, "wrangler.toml"), "utf8"),
  ) as {
    main: string;
    alias?: Record<string, string>;
  };
  const aliases = Object.entries(config.alias ?? {}).map(
    ([from, to]) => [from, path.resolve(apiRoot, to)] as const,
  );
  const result = await Bun.build({
    entrypoints: [path.join(apiRoot, config.main)],
    target: "browser",
    format: "esm",
    conditions: ["eliza-source", "workerd", "worker", "browser"],
    metafile: true,
    throw: false,
    plugins: [
      {
        name: "worker-graph",
        setup(build) {
          for (const [from, to] of aliases) {
            const exact = new RegExp(
              `^${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`,
            );
            build.onResolve({ filter: exact }, () => ({ path: to }));
          }
          // Third-party internals and platform builtins are not workspace
          // source; keep them out of the walk so the graph stays fast and exact.
          build.onResolve({ filter: /.*/ }, (args) =>
            args.importer.includes("/node_modules/") ||
            args.path.startsWith("node:") ||
            args.path.startsWith("cloudflare:") ||
            builtinModules.includes(args.path.split("/")[0] ?? "")
              ? { path: args.path, external: true }
              : undefined,
          );
        },
      },
    ],
  } as Parameters<typeof Bun.build>[0]);
  const { metafile } = result as unknown as {
    metafile?: { inputs: Record<string, unknown> };
  };
  if (!result.success || !metafile) {
    throw new Error(
      `Worker graph build failed:\n${result.logs.slice(0, 10).join("\n")}`,
    );
  }
  return Object.keys(metafile.inputs)
    .map((input) => path.resolve(process.cwd(), input))
    .filter((file) => !file.includes("/node_modules/"));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

const transpilers = new Map<string, Bun.Transpiler>();
/** Count real `redirect: "error"` properties — comments are stripped first. */
function redirectErrorUses(file: string): number {
  const source = readFileSync(file, "utf8");
  if (!source.includes("error")) return 0;
  const loader = file.endsWith(".tsx")
    ? "tsx"
    : /\.[cm]?ts$/.test(file)
      ? "ts"
      : "js";
  let transpiler = transpilers.get(loader);
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader, deadCodeElimination: false });
    transpilers.set(loader, transpiler);
  }
  let code: string;
  try {
    code = transpiler.transformSync(source);
  } catch {
    // error-policy:J3 A file the transpiler cannot parse is scanned raw: that can
    // only over-report (comments included), never hide a use.
    code = source;
  }
  return code.match(REDIRECT_ERROR)?.length ?? 0;
}

test('no Worker-reachable module sends redirect: "error" to a platform fetch', async () => {
  const graph = await workerImportGraph();
  const repoRoot = path.resolve(cloudRoot, "../..");
  // The graph must actually span the shared library and the workspace packages
  // the Worker bundles, or this scan proves nothing.
  expect(graph.some((file) => file.startsWith(sharedSrc))).toBe(true);
  expect(graph).toContain(
    path.join(repoRoot, "packages/auth/src/sdk/transport.ts"),
  );
  expect(graph).toContain(
    path.join(repoRoot, "packages/core/src/security/confidential-inference.ts"),
  );

  const files = new Set(
    graph.filter((file) => SOURCE.test(file) && !TEST_FILE.test(file)),
  );
  for (const file of walk(apiRoot)) if (!TEST_FILE.test(file)) files.add(file);
  // shared/src/node/* is the Node-only sidecar entry; it is not a Worker module
  // unless the graph above reaches it.
  for (const file of walk(sharedSrc)) {
    if (
      !TEST_FILE.test(file) &&
      !file.startsWith(path.join(sharedSrc, "node/"))
    )
      files.add(file);
  }

  const violations: string[] = [];
  for (const file of [...files].sort()) {
    const uses = redirectErrorUses(file);
    if (uses === 0) continue;
    const key = path.relative(cloudRoot, file);
    if (SAFE_FETCH_ROUTED[key] === uses) continue;
    violations.push(`${path.relative(repoRoot, file)} (${uses})`);
  }
  expect(violations).toEqual([]);
});

test("the scan recognises the forms it must reject and ignores comments", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const uses = (source: string) =>
    transpiler.transformSync(source).match(REDIRECT_ERROR)?.length ?? 0;
  expect(uses(`export const a = fetch(u, { redirect: "error" });`)).toBe(1);
  expect(
    uses(`export const r = new Request(u, { redirect: 'error' as const });`),
  ).toBe(1);
  expect(
    uses(`// redirect: "error" is rejected by workerd\nexport const a = 1;`),
  ).toBe(0);
  expect(uses(`export const a = fetch(u, { redirect: "manual" });`)).toBe(0);
});
