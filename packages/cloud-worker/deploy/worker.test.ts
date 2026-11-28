// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"
import fs from "node:fs"
import path from "node:path"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Test from "@alchemy.run/test/Vitest"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import { afterAll as vitestAfterAll, beforeAll as vitestBeforeAll, expect } from "vitest"
import { hashAssetDirectory, resolveStage, verifyDeploymentEndpoints } from "vibestack/alchemy"
import { serveDatabase } from "../test/support/database.ts"
import { testDatabaseIdentity } from "../test/support/profile.ts"
import { workerBindings } from "../test/support/worker.ts"

const packageDir = path.resolve(import.meta.dirname, "..")
const pagesDir = path.join(packageDir, "dist/pages")
const entryMain = path.join(packageDir, "dist/worker/entry.mjs")
const migrationsDir = path.join(packageDir, "src/store/migrations")
const stage = resolveStage({ mode: "test", cwd: packageDir }).stage

let databaseUrl = ""
let closeDatabase: (() => Promise<void>) | undefined

vitestBeforeAll(async () => {
  const served = await serveDatabase(async (db) => {
    await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)")
    const names = fs.readdirSync(migrationsDir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
    for (const name of names) {
      await db.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"))
      await db.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)", [name, 1])
    }
    await db.query("INSERT INTO cloud_identity (digest, environment, created_at) VALUES ($1, $2, $3)", [testDatabaseIdentity, "staging", 1])
  })
  databaseUrl = served.url
  closeDatabase = served.close
}, 60_000)

vitestAfterAll(async () => {
  await closeDatabase?.()
})

const CloudWorkerWorkerdStack = Alchemy.Stack(
  "ElizaCloudWorkerWorkerdTest",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const assets = hashAssetDirectory(pagesDir)
    const bindings = workerBindings({
      api: "https://api.staging.example.com",
      web: "https://www.staging.example.com",
      digest: testDatabaseIdentity,
    })
    const worker = yield* Cloudflare.Worker("ElizaCloudApi", {
      main: entryMain,
      bundle: false,
      compatibility: {
        date: "2026-10-15",
        flags: ["nodejs_compat"],
      },
      assets: {
        directory: assets.directory,
        hash: assets.hash,
        runWorkerFirst: true,
      },
      workersDev: true,
      env: {
        ...bindings,
        DATABASE_URL: databaseUrl,
      },
    })
    return { url: worker.url, assetHash: assets.hash }
  }),
)

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  stage,
})

const stack = beforeAll(deploy(CloudWorkerWorkerdStack))
afterAll(destroy(CloudWorkerWorkerdStack))

test(
  'serves health, public service document, sign-in methods, and static checkout outcome inside local workerd (spec/cloud/deployment.md, "Story: Serve the deployment from a Worker")',
  Effect.gen(function* () {
    const outputs = yield* stack
    expect(outputs?.url).toMatch(/^http:\/\/(?:localhost|127\.0\.0\.1):/)
    const url = outputs?.url
    if (!url) throw new Error("Missing local workerd URL")
    const receipt = yield* Effect.promise(() =>
      verifyDeploymentEndpoints(
        url,
        [
          {
            path: "/api/health",
            expectedStatus: 200,
            expectJson: (parsed) =>
              typeof parsed === "object" && parsed !== null && (parsed as { status?: unknown }).status === "ok"
                ? true
                : "health response missing status=ok",
          },
          {
            path: "/api/public/service",
            expectedStatus: 200,
            expectJson: (parsed) => {
              const body = parsed as { success?: unknown; version?: unknown } | null
              return typeof body === "object" && body !== null && body.success === true && body.version === 1
                ? true
                : "public service response invalid"
            },
          },
          {
            path: "/api/v1/auth/methods",
            expectedStatus: 200,
            expectJson: (parsed) => {
              const body = parsed as { email?: unknown; sms?: unknown; google?: unknown } | null
              return typeof body === "object"
                && body !== null
                && body.email === true
                && body.sms === false
                && body.google === true
                ? true
                : `unexpected auth methods: ${JSON.stringify(parsed)}`
            },
          },
          {
            path: "/api/v1/subscriptions/checkout/payer?outcome=paid",
            expectedStatus: 404,
            expectJson: (parsed) => {
              const body = parsed as { error?: unknown; retryable?: unknown } | null
              return body?.error === "capability_unavailable" && body.retryable === false
                ? true
                : `expected capability_unavailable refusal: ${JSON.stringify(parsed)}`
            },
          },
          {
            path: "/return-to-app.html",
            expectedStatus: 404,
          },
        ],
        { assetHash: outputs.assetHash, maxAttempts: 6, initialDelayMs: 250, maxDelayMs: 2000 },
      ),
    )
    expect(receipt.ok).toBe(true)
    expect(receipt.probes).toHaveLength(5)
  }),
)
