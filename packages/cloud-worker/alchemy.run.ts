// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"
import path from "node:path"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import { makeBucketState } from "alchemy/State/BucketState"
import { State, StateStoreError } from "alchemy/State/State"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import {
  assertStageGuard,
  hashAssetDirectory,
  makeR2BucketObjects,
  resolveStage,
  verifyDeploymentEndpoints,
  type StageTarget,
} from "vibestack/alchemy"

const packageDir = import.meta.dirname
const pagesDir = path.join(packageDir, "dist/pages")
const workerDir = path.join(packageDir, "dist/worker")
const productionDomains = ["api.eliza.app"] as const

function resolveStateLayer() {
  if (process.env.ALCHEMY_STATE_STORE === "cloudflare") {
    return Cloudflare.state({
      ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
    })
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const accessKeyId = process.env.R2_STATE_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_STATE_SECRET_ACCESS_KEY?.trim()
  const bucket = process.env.R2_STATE_BUCKET?.trim()
  if (accountId && accessKeyId && secretAccessKey && bucket) {
    const objects = makeR2BucketObjects<StateStoreError>(
      { kind: "s3", accountId, bucket, accessKeyId, secretAccessKey },
      {
        tryPromise: Effect.tryPromise,
        makeError: ({ message, cause, status }) =>
          new StateStoreError({
            message,
            ...(cause ? { cause } : {}),
            ...(status !== undefined ? { http: { status } } : {}),
          }),
      },
    )
    return Layer.effect(
      State,
      Effect.gen(function* () {
        const context = yield* Effect.context()
        const scope = yield* Effect.scope
        const make = makeBucketState({
          id: "r2",
          label: "Cloudflare R2",
          prefix: process.env.R2_STATE_PREFIX ?? "alchemy/eliza-cloud-worker/",
          objects: Effect.succeed(objects),
        }).pipe(Scope.provide(scope), Effect.provideContext(context))
        return yield* Effect.cached(make)
      }),
    )
  }
  return Alchemy.localState()
}

function workerNameFor(target: StageTarget): string {
  switch (target.kind) {
    case "production":
      return "eliza-cloud-api-prod"
    case "staging":
      return "eliza-cloud-api-staging"
    case "preview":
    case "dev":
    case "test":
      return `eliza-cloud-api-${target.stage.replaceAll("_", "-")}`
  }
}

function canonicalOriginFor(target: StageTarget): string | undefined {
  if (target.kind === "production") return process.env.PUBLIC_API_ORIGIN?.trim() || "https://api.eliza.app"
  if (target.kind === "staging") return process.env.PUBLIC_API_ORIGIN?.trim() || "https://api-staging.eliza.app"
  return process.env.PUBLIC_API_ORIGIN?.trim() || undefined
}

function parseDevOrigin(databaseUrl: string | undefined): Cloudflare.Hyperdrive.DevOrigin | undefined {
  if (!databaseUrl) return undefined
  try {
    const parsed = new URL(databaseUrl)
    const scheme = parsed.protocol === "postgresql:" ? "postgresql" : parsed.protocol === "postgres:" ? "postgres" : undefined
    if (!scheme || !parsed.hostname) return undefined
    const database = parsed.pathname.replace(/^\/+/, "") || "postgres"
    return {
      scheme,
      host: parsed.hostname,
      ...(parsed.port ? { port: Number(parsed.port) } : {}),
      database,
      user: decodeURIComponent(parsed.username || "postgres"),
      password: Redacted.make(decodeURIComponent(parsed.password || "")),
      sslmode: "disable",
    }
  } catch {
    return undefined
  }
}

function buildWorkerEnv(target: StageTarget): Cloudflare.Workers.WorkerBindingProps {
  const cloudEnvironment = target.kind === "production" ? "production" : "staging"
  const env: Cloudflare.Workers.WorkerBindingProps = {
    CLOUD_ENVIRONMENT: cloudEnvironment,
  }
  const digest = process.env.CLOUD_IDENTITY_DIGEST?.trim() || process.env.ELIZA_CLOUD_V4_DATABASE_IDENTITY?.trim()
  if (digest) env.CLOUD_IDENTITY_DIGEST = digest
  const apiOrigin = canonicalOriginFor(target)
  if (apiOrigin) env.PUBLIC_API_ORIGIN = apiOrigin
  const webOrigin = process.env.WEB_ORIGIN?.trim()
  if (webOrigin) env.WEB_ORIGIN = webOrigin
  const profile = process.env.CLOUD_PROFILE?.trim()
  if (profile) env.CLOUD_PROFILE = profile
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl && target.kind !== "production") env.DATABASE_URL = databaseUrl

  const hyperdriveId = process.env.ELIZA_CLOUD_HYPERDRIVE_ID?.trim()
  const hyperdriveName = process.env.ELIZA_CLOUD_HYPERDRIVE_NAME?.trim()
  const devOrigin = parseDevOrigin(databaseUrl)
  if (hyperdriveId) {
    env.HYPERDRIVE = Cloudflare.Hyperdrive.lookup("HYPERDRIVE", {
      hyperdriveId,
      ...(devOrigin ? { dev: devOrigin } : {}),
    })
  } else if (hyperdriveName) {
    env.HYPERDRIVE = Cloudflare.Hyperdrive.lookup("HYPERDRIVE", {
      name: hyperdriveName,
      ...(devOrigin ? { dev: devOrigin } : {}),
    })
  }
  if (process.env.ELIZA_CLOUD_ENABLE_AI === "true") {
    env.AI = Cloudflare.Workers.AI()
  }
  if (process.env.ELIZA_CLOUD_ENABLE_EMAIL_BINDING === "true") {
    const sender = process.env.ELIZA_CLOUD_EMAIL_SENDER?.trim()
    env.SIGN_IN_EMAIL = Cloudflare.Email.SendEmail(
      "SIGN_IN_EMAIL",
      sender ? { allowedSenderAddresses: [sender] } : {},
    )
  }
  return env
}

const VerifyCloudWorker = Alchemy.Action(
  "VerifyCloudWorker",
  (input: {
    readonly workerName: string
    readonly canonicalOrigin: string | undefined
    readonly workerUrl: string | undefined
    readonly assetHash: string
    readonly skip: boolean
  }) =>
    Effect.tryPromise(async () => {
      const baseUrl = input.canonicalOrigin ?? input.workerUrl
      if (input.skip) {
        return { ok: true, skipped: true, workerName: input.workerName, baseUrl: baseUrl ?? "", assetHash: input.assetHash }
      }
      if (!baseUrl) {
        throw new Error(`Deployed Eliza Cloud Worker ${input.workerName} did not expose a verifiable URL`)
      }
      return verifyDeploymentEndpoints(
        baseUrl,
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
                : "public service document did not return success=true version=1"
            },
          },
          {
            path: "/api/v1/auth/methods",
            expectedStatus: 200,
            expectJson: (parsed) => {
              const body = parsed as { email?: unknown; sms?: unknown; google?: unknown } | null
              return typeof body === "object"
                && body !== null
                && typeof body.email === "boolean"
                && typeof body.sms === "boolean"
                && typeof body.google === "boolean"
                && (body.email || body.sms || body.google)
                ? true
                : "auth methods did not advertise at least one sign-in method"
            },
          },
        ],
        { assetHash: input.assetHash, maxAttempts: 8, initialDelayMs: 1000, maxDelayMs: 10_000 },
      )
    }),
)

export default Alchemy.Stack(
  "ElizaCloudWorker",
  {
    providers: Cloudflare.providers(),
    state: resolveStateLayer(),
  },
  Effect.gen(function* () {
    const stageName = yield* Alchemy.Stage
    const stageTarget = resolveStage({ stage: stageName, cwd: packageDir })
    const isManagedRelease = stageTarget.kind === "staging" || stageTarget.kind === "production"
    const canonicalOrigin = canonicalOriginFor(stageTarget)
    const customDomain = stageTarget.kind === "production" && process.env.ELIZA_CLOUD_BIND_DOMAIN === "true"
      ? "api.eliza.app"
      : stageTarget.kind === "staging" && process.env.ELIZA_CLOUD_BIND_DOMAIN === "true"
        ? "api-staging.eliza.app"
        : undefined
    const prodHyperdriveId = process.env.ELIZA_CLOUD_PROD_HYPERDRIVE_ID?.trim()

    assertStageGuard(stageTarget, {
      resourceIds: {
        HYPERDRIVE: process.env.ELIZA_CLOUD_HYPERDRIVE_ID,
      },
      domains: customDomain ? [customDomain] : canonicalOrigin ? [canonicalOrigin] : [],
      productionIds: prodHyperdriveId ? [prodHyperdriveId] : [],
      productionDomains,
    })

    const pagesAssets = hashAssetDirectory(pagesDir)
    const entryMain = path.join(
      workerDir,
      stageTarget.kind === "production" ? "entry-production.mjs" : "entry.mjs",
    )

    const workerResource = Cloudflare.Worker("ElizaCloudApi", {
      name: workerNameFor(stageTarget),
      main: entryMain,
      bundle: false,
      compatibility: {
        date: "2026-10-15",
        flags: ["nodejs_compat"],
      },
      assets: {
        directory: pagesAssets.directory,
        hash: pagesAssets.hash,
        runWorkerFirst: true,
      },
      workersDev: !isManagedRelease,
      ...(customDomain ? { domain: customDomain } : {}),
      ...(isManagedRelease ? { crons: ["* * * * *"] } : {}),
      env: buildWorkerEnv(stageTarget),
    }).pipe(Alchemy.AdoptPolicy.adopt(true))

    const worker = yield* (isManagedRelease
      ? workerResource.pipe(Alchemy.RemovalPolicy.retain())
      : workerResource)

    const receipt = yield* VerifyCloudWorker({
      workerName: worker.workerName,
      canonicalOrigin,
      workerUrl: worker.url,
      assetHash: pagesAssets.hash,
      skip: process.env.ELIZA_CLOUD_SKIP_VERIFY === "1",
    })

    return {
      stage: stageTarget.stage,
      workerName: worker.workerName,
      url: worker.url,
      canonicalOrigin,
      assetHash: pagesAssets.hash,
      receipt,
    }
  }),
)
