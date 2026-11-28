// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"
import fs from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import { build, type Plugin } from "esbuild"

const packageDir = path.resolve(import.meta.dirname, "..")
const outDir = path.join(packageDir, "dist/worker")
const compiledWorker = path.join(packageDir, "dist/src/worker.js")
const bareBuiltins = new Set(builtinModules.filter((name) => !name.startsWith("node:")))

function cloudWorkerBuildPlugins(): Plugin[] {
  return [
    {
      name: "resolve-compiled-cloud-worker",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^\.\.\/src\/worker\.vibe$/ }, () => ({
          path: compiledWorker,
        }))
        pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path === "pg-native") {
            return { path: "pg-native", namespace: "empty-stub" }
          }
          if (bareBuiltins.has(args.path)) {
            return { path: `node:${args.path}`, external: true }
          }
          return undefined
        })
        pluginBuild.onLoad({ filter: /.*/, namespace: "empty-stub" }, () => ({
          contents: "export default {}",
          loader: "js",
        }))
      },
    },
  ]
}

function readBundledProfile(): string | undefined {
  const raw = process.env.ELIZA_CLOUD_V4_PROFILE?.trim()
  if (raw && raw.length > 0) {
    JSON.parse(raw)
    return raw
  }
  const profileFile = process.env.ELIZA_CLOUD_PROFILE_FILE?.trim()
  if (profileFile && fs.existsSync(profileFile)) {
    const content = fs.readFileSync(profileFile, "utf8").trim()
    JSON.parse(content)
    return content
  }
  return undefined
}

async function main(): Promise<void> {
  if (!fs.existsSync(compiledWorker)) {
    throw new Error(`Missing compiled worker module: ${compiledWorker}`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  const bundledProfile = readBundledProfile()
  const define = {
    __BUNDLED_CLOUD_PROFILE__: bundledProfile === undefined ? "undefined" : JSON.stringify(bundledProfile),
  }
  const common = {
    bundle: true,
    format: "esm" as const,
    platform: "node" as const,
    target: "es2024",
    conditions: ["workerd", "worker"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"],
    banner: {
      js: 'import { createRequire as __alchemyCreateRequire } from "node:module"; const require = __alchemyCreateRequire(import.meta.url);',
    },
    plugins: cloudWorkerBuildPlugins(),
    define,
    sourcemap: false,
    logLevel: "error" as const,
  }
  await Promise.all([
    build({
      ...common,
      entryPoints: [path.join(packageDir, "deploy/worker-entry.ts")],
      outfile: path.join(outDir, "entry.mjs"),
    }),
    build({
      ...common,
      entryPoints: [path.join(packageDir, "deploy/worker-entry-production.ts")],
      outfile: path.join(outDir, "entry-production.mjs"),
    }),
  ])
}

await main()
