// spec/cloud/deployment.md, "Story: Serve the deployment from a Worker"
import path from "node:path"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Output from "alchemy/Output"
import { makeBucketState } from "alchemy/State/BucketState"
import { State, StateStoreError } from "alchemy/State/State"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import {
  assertStageGuard,
  createHyperdriveRef,
  hashAssetDirectory,
  makeR2BucketObjects,
  resolveStage,
  verifyDeploymentEndpoints,
  type StageTarget,
} from "vibestack/alchemy"

const packageDir = import.meta.dirname
const pagesDir = path.join(packageDir, "dist/pages")
const workerDir = path.join(packageDir, "dist/worker")
const PRODUCTION_HYPERDRIVE_ID = "32b979608df74c76a1dc9d838b34ff1b"
const STAGING_HYPERDRIVE_ID = "328267e25f574e6a8c210804769b39e7"
const DEFAULT_SIGN_IN_SENDER = "sign-in@cloud-mail.eliza.app"
const REMOTE_COMPATIBILITY_DATE = "2026-11-25"
const LOCAL_COMPATIBILITY_DATE = "2026-10-15"
const productionDomains = ["api.eliza.app", "cloud.eliza.app"] as const

interface WranglerConfig {
  readonly name?: string
  readonly accountId?: string
  readonly compatibilityDate?: string
  readonly compatibilityFlags?: readonly string[]
  readonly hyperdriveId?: string
  readonly sendEmailAllowedSenders?: readonly string[]
  readonly hasSendEmailBinding: boolean
  readonly vars: Readonly<Record<string, string>>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function asStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .map((entry) => asNonEmptyString(entry))
    .filter((entry): entry is string => entry !== undefined)
  return items.length > 0 ? items : undefined
}

function parseWranglerConfig(raw: string | undefined): WranglerConfig {
  const empty: WranglerConfig = { hasSendEmailBinding: false, vars: {} }
  const trimmed = raw?.trim()
  if (!trimmed) return empty
  const parsed = asRecord(JSON.parse(trimmed))
  if (!parsed) throw new Error("ELIZA_CLOUD_V4_WRANGLER_CONFIG must decode to a JSON object")

  const hyperdriveEntry = Array.isArray(parsed.hyperdrive)
    ? parsed.hyperdrive
        .map((entry) => asRecord(entry))
        .find((entry) => entry && asNonEmptyString(entry.binding) === "HYPERDRIVE")
    : undefined
  const emailEntry = Array.isArray(parsed.send_email)
    ? parsed.send_email
        .map((entry) => asRecord(entry))
        .find((entry) => entry && asNonEmptyString(entry.name) === "SIGN_IN_EMAIL")
    : undefined
  const rawVars = asRecord(parsed.vars)
  const vars: Record<string, string> = {}
  if (rawVars) {
    for (const [key, value] of Object.entries(rawVars)) {
      const normalized = asNonEmptyString(value)
      if (normalized) vars[key] = normalized
    }
  }

  return {
    ...(asNonEmptyString(parsed.name) ? { name: asNonEmptyString(parsed.name) } : {}),
    ...(asNonEmptyString(parsed.account_id) ? { accountId: asNonEmptyString(parsed.account_id) } : {}),
    ...(asNonEmptyString(parsed.compatibility_date) ? { compatibilityDate: asNonEmptyString(parsed.compatibility_date) } : {}),
    ...(asStringList(parsed.compatibility_flags) ? { compatibilityFlags: asStringList(parsed.compatibility_flags) } : {}),
    ...(hyperdriveEntry && asNonEmptyString(hyperdriveEntry.id) ? { hyperdriveId: asNonEmptyString(hyperdriveEntry.id) } : {}),
    ...(emailEntry && asStringList(emailEntry.allowed_sender_addresses)
      ? { sendEmailAllowedSenders: asStringList(emailEntry.allowed_sender_addresses) }
      : {}),
    hasSendEmailBinding: emailEntry !== undefined,
    vars,
  }
}

const wranglerConfig = parseWranglerConfig(process.env.ELIZA_CLOUD_V4_WRANGLER_CONFIG)

function resolveStateLayer() {
  return Layer.unwrap(
    Effect.gen(function* () {
      const stageName = yield* Alchemy.Stage
      const stageTarget = resolveStage({ stage: stageName, cwd: packageDir })
      if (stageTarget.kind === "dev" || stageTarget.kind === "test") {
        return Alchemy.localState()
      }
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || wranglerConfig.accountId
      if (process.env.ALCHEMY_STATE_STORE?.trim() === "cloudflare") {
        return Cloudflare.state({
          ...(accountId ? { accountId } : {}),
        })
      }
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
        const prefix = process.env.R2_STATE_PREFIX?.trim() || "alchemy/eliza-cloud-worker/"
        return Layer.effect(
          State,
          Effect.gen(function* () {
            const context = yield* Effect.context()
            const scope = yield* Effect.scope
            const make = makeBucketState({
              id: "r2",
              label: "Cloudflare R2",
              prefix,
              objects: Effect.succeed(objects),
            }).pipe(Scope.provide(scope), Effect.provideContext(context))
            return yield* Effect.cached(make)
          }),
        )
      }
      return Alchemy.localState()
    }),
  )
}

interface ResolvedCloudWorkerConfig {
  readonly workerName: string
  readonly cloudEnvironment: "staging" | "production"
  readonly compatibilityDate: string
  readonly compatibilityFlags: readonly string[]
  readonly publicApiOrigin?: string
  readonly webOrigin?: string
  readonly identityDigest?: string
  readonly hyperdriveId?: string
  readonly hyperdriveName?: string
  readonly sendEmailAllowedSenders?: readonly string[]
  readonly enableEmailBinding: boolean
}

function resolveCloudWorkerConfig(target: StageTarget, config: WranglerConfig): ResolvedCloudWorkerConfig {
  const isManagedRelease = target.kind === "staging" || target.kind === "production"
  const isLocalStage = target.kind === "dev" || target.kind === "test"
  const cloudEnvironment = target.kind === "production" ? "production" : "staging"

  const defaultWorkerName = target.kind === "production"
    ? "eliza-cloud-api-prod"
    : target.kind === "staging"
      ? "eliza-cloud-api-staging"
      : `eliza-cloud-api-${target.stage.replaceAll("_", "-")}`
  const defaultPublicApiOrigin = target.kind === "production"
    ? "https://api.eliza.app"
    : target.kind === "staging"
      ? "https://api-staging.eliza.app"
      : undefined
  const defaultWebOrigin = target.kind === "production"
    ? "https://cloud.eliza.app"
    : target.kind === "staging"
      ? "https://staging.eliza.app"
      : undefined
  const defaultHyperdriveId = target.kind === "production"
    ? PRODUCTION_HYPERDRIVE_ID
    : target.kind === "staging"
      ? STAGING_HYPERDRIVE_ID
      : undefined
  const defaultSenders = isManagedRelease ? [DEFAULT_SIGN_IN_SENDER] : undefined

  const workerName = (isManagedRelease ? config.name : undefined) ?? defaultWorkerName
  const compatibilityDate = isLocalStage
    ? LOCAL_COMPATIBILITY_DATE
    : (config.compatibilityDate ?? REMOTE_COMPATIBILITY_DATE)
  const compatibilityFlags = config.compatibilityFlags ?? ["nodejs_compat"]
  const publicApiOrigin = process.env.PUBLIC_API_ORIGIN?.trim()
    || config.vars.PUBLIC_API_ORIGIN
    || defaultPublicApiOrigin
  const webOrigin = process.env.WEB_ORIGIN?.trim()
    || config.vars.WEB_ORIGIN
    || defaultWebOrigin
  const identityDigest = process.env.CLOUD_IDENTITY_DIGEST?.trim()
    || process.env.ELIZA_CLOUD_V4_DATABASE_IDENTITY?.trim()
    || config.vars.CLOUD_IDENTITY_DIGEST
  const hyperdriveId = process.env.ELIZA_CLOUD_HYPERDRIVE_ID?.trim()
    || config.hyperdriveId
    || defaultHyperdriveId
  const hyperdriveName = process.env.ELIZA_CLOUD_HYPERDRIVE_NAME?.trim() || undefined
  const envEmailSender = process.env.ELIZA_CLOUD_EMAIL_SENDER?.trim()
  const sendEmailAllowedSenders = envEmailSender
    ? [envEmailSender]
    : (config.sendEmailAllowedSenders ?? defaultSenders)
  const emailToggle = process.env.ELIZA_CLOUD_ENABLE_EMAIL_BINDING?.trim()
  const enableEmailBinding = emailToggle === "false"
    ? false
    : emailToggle === "true" || config.hasSendEmailBinding || isManagedRelease

  return {
    workerName,
    cloudEnvironment,
    compatibilityDate,
    compatibilityFlags,
    ...(publicApiOrigin ? { publicApiOrigin } : {}),
    ...(webOrigin ? { webOrigin } : {}),
    ...(identityDigest ? { identityDigest } : {}),
    ...(hyperdriveId ? { hyperdriveId } : {}),
    ...(hyperdriveName ? { hyperdriveName } : {}),
    ...(sendEmailAllowedSenders ? { sendEmailAllowedSenders } : {}),
    enableEmailBinding,
  }
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

function buildWorkerEnv(
  target: StageTarget,
  resolved: ResolvedCloudWorkerConfig,
  config: WranglerConfig,
): Cloudflare.Workers.WorkerBindingProps {
  const env: Cloudflare.Workers.WorkerBindingProps = {
    ...config.vars,
    CLOUD_ENVIRONMENT: resolved.cloudEnvironment,
  }
  if (resolved.identityDigest) env.CLOUD_IDENTITY_DIGEST = resolved.identityDigest
  if (resolved.publicApiOrigin) env.PUBLIC_API_ORIGIN = resolved.publicApiOrigin
  if (resolved.webOrigin) env.WEB_ORIGIN = resolved.webOrigin
  const profile = process.env.CLOUD_PROFILE?.trim()
  if (profile) env.CLOUD_PROFILE = profile
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl && target.kind !== "production") env.DATABASE_URL = databaseUrl

  const devOrigin = parseDevOrigin(databaseUrl)
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || config.accountId
  if (resolved.hyperdriveId) {
    env.HYPERDRIVE = createHyperdriveRef({
      id: "HYPERDRIVE",
      hyperdriveId: resolved.hyperdriveId,
      ...(accountId ? { accountId } : {}),
      ...(devOrigin ? { dev: devOrigin } : {}),
      asOutput: Output.asOutput,
      isConnectionLookup: Cloudflare.Hyperdrive.isConnectionLookup,
    })
  } else if (resolved.hyperdriveName) {
    env.HYPERDRIVE = Cloudflare.Hyperdrive.lookup("HYPERDRIVE", {
      name: resolved.hyperdriveName,
      ...(devOrigin ? { dev: devOrigin } : {}),
    })
  }
  if (process.env.ELIZA_CLOUD_ENABLE_AI === "true") {
    env.AI = Cloudflare.Workers.AI()
  }
  if (resolved.enableEmailBinding) {
    env.SIGN_IN_EMAIL = Cloudflare.Email.SendEmail(
      "SIGN_IN_EMAIL",
      resolved.sendEmailAllowedSenders && resolved.sendEmailAllowedSenders.length > 0
        ? { allowedSenderAddresses: [...resolved.sendEmailAllowedSenders] }
        : {},
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
    const resolved = resolveCloudWorkerConfig(stageTarget, wranglerConfig)
    const canonicalOrigin = resolved.publicApiOrigin
    const customDomain = stageTarget.kind === "production" && process.env.ELIZA_CLOUD_BIND_DOMAIN === "true"
      ? "api.eliza.app"
      : stageTarget.kind === "staging" && process.env.ELIZA_CLOUD_BIND_DOMAIN === "true"
        ? "api-staging.eliza.app"
        : undefined
    const prodHyperdriveIdOverride = process.env.ELIZA_CLOUD_PROD_HYPERDRIVE_ID?.trim()
    const productionIds = prodHyperdriveIdOverride && prodHyperdriveIdOverride !== PRODUCTION_HYPERDRIVE_ID
      ? [PRODUCTION_HYPERDRIVE_ID, prodHyperdriveIdOverride]
      : [PRODUCTION_HYPERDRIVE_ID]
    const guardedDomains = [customDomain, canonicalOrigin, resolved.webOrigin].filter(
      (value): value is string => value !== undefined,
    )

    assertStageGuard(stageTarget, {
      resourceIds: {
        ...(resolved.hyperdriveId ? { HYPERDRIVE: resolved.hyperdriveId } : {}),
      },
      domains: guardedDomains,
      productionIds,
      productionDomains,
    })

    const pagesAssets = hashAssetDirectory(pagesDir)
    const entryMain = path.join(
      workerDir,
      stageTarget.kind === "production" ? "entry-production.mjs" : "entry.mjs",
    )

    const workerResource = Cloudflare.Worker("ElizaCloudApi", {
      name: resolved.workerName,
      main: entryMain,
      bundle: false,
      compatibility: {
        date: resolved.compatibilityDate,
        flags: [...resolved.compatibilityFlags],
      },
      assets: {
        directory: pagesAssets.directory,
        hash: pagesAssets.hash,
        runWorkerFirst: true,
      },
      workersDev: !isManagedRelease,
      ...(customDomain ? { domain: customDomain } : {}),
      ...(isManagedRelease ? { crons: ["* * * * *"] } : {}),
      env: buildWorkerEnv(stageTarget, resolved, wranglerConfig),
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
