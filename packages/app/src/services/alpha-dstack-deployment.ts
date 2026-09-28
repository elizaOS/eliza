/**
 * Renders the Alpha agent's measured dstack application (app-compose.json and
 * its docker compose) from a non-secret deployment record and a digest-pinned
 * image record. Secrets are never rendered: compose only names them in
 * `allowed_envs`, and their values arrive through dstack's KMS-encrypted
 * environment, authenticated by confidential-bootstrap.mjs before the agent
 * imports. Local models are disabled; text, embeddings and speech are remote.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

export const ALPHA_AGENT_PORT = 2138;
export const ALPHA_STATE_DIR = "/data/eliza";
export const ALPHA_LAUNCH_CONFIG_PATH = "/etc/eliza-alpha/launch.json";
export const ALPHA_DSTACK_SOCKET = "/var/run/dstack.sock";
export const ALPHA_VERIFIER_PATH = "/opt/dstack/dstack-verifier";
export const ALPHA_VERIFIER_CONFIG_PATH = "/opt/dstack/dstack-verifier.toml";
const ENTRY_PATH = "/opt/eliza-alpha/alpha-entry.mjs";
const BOOTSTRAP_PATH = "/opt/eliza-alpha/confidential-bootstrap.mjs";
const TSX_LOADER = "/opt/tsx/node_modules/tsx/dist/loader.mjs";
/** Names dstack injects from the encrypted environment for the bootstrap. */
const DSTACK_LAUNCH_ENV = [
  "ELIZA_DSTACK_LAUNCH_AUTHORIZATION_JSON",
  "ELIZA_DSTACK_RELEASE_POLICY_JSON",
] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const httpsOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === value
    );
  } catch {
    // error-policy:J3 A malformed origin is never a deployment endpoint.
    return false;
  }
}, "must be an HTTPS origin without a trailing slash");
const httpsUrl = z.url().refine((value) => value.startsWith("https://"));
const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const alphaDeploymentSchema = z
  .object({
    schemaVersion: z.literal(1),
    agentId: z.uuid(),
    deploymentId: identifier,
    variant: z.enum(["dstack-tdx", "dstack-nitro-enclave"]),
    osImageHash: sha256,
    release: z
      .object({ notBefore: z.iso.datetime(), expiresAt: z.iso.datetime() })
      .strict(),
    /** Stable origin the phone APK pins; must survive app-id changes. */
    publicOrigin: httpsOrigin,
    kms: z
      .object({
        keyProviderId: z.string().regex(/^(?:[a-f0-9]{2})+$/),
        urls: z.array(httpsUrl).min(1),
        envEncryptEndpoint: z.url(),
        signingPublicKey: z.string().regex(/^(02|03)[a-f0-9]{64}$/),
      })
      .strict(),
    vmm: z
      .object({
        endpoint: z.url(),
        image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
        vcpu: z.number().int().min(1).max(64),
        memoryMb: z.number().int().min(2048),
        diskGb: z.number().int().min(20),
      })
      .strict(),
    models: z.object({ small: modelName, large: modelName }).strict(),
    embeddings: z.discriminatedUnion("provider", [
      z
        .object({
          provider: z.literal("elizacloud"),
          model: modelName.optional(),
          dimensions: z.number().int().positive().optional(),
        })
        .strict(),
      z
        .object({
          provider: z.literal("openai-compatible"),
          baseUrl: httpsUrl,
          model: modelName,
          dimensions: z.number().int().positive(),
        })
        .strict(),
    ]),
    speech: z
      .object({
        provider: z.literal("elizacloud"),
        ttsModel: modelName.optional(),
        ttsVoice: z.string().min(1).optional(),
      })
      .strict(),
    processors: z
      .object({
        allowedRegions: z.array(identifier).min(1),
        cerebras: z
          .object({
            endpoint: httpsUrl.default("https://api.cerebras.ai/v1"),
            region: identifier,
            contractRef: identifier,
            approvalRef: identifier,
            expiresAt: z.iso.datetime(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type AlphaDeployment = z.output<typeof alphaDeploymentSchema>;

export const alphaImageRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    image: z
      .string()
      .regex(
        /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/,
        "image must be referenced by registry digest",
      ),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    verifier: z
      .object({ image: z.string().min(1), sha256, configSha256: sha256 })
      .strict(),
  })
  .passthrough();
export type AlphaImageRecord = z.output<typeof alphaImageRecordSchema>;

/** Secret names, in the order operators must supply them. */
export function alphaSecretNames(deployment: AlphaDeployment): string[] {
  return [
    "CEREBRAS_API_KEY",
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZA_API_TOKEN",
    "ELIZA_VAULT_PASSPHRASE",
    ...(deployment.embeddings.provider === "openai-compatible"
      ? ["EMBEDDING_API_KEY"]
      : []),
  ].sort();
}

/** Validates operator secrets without ever echoing their values. */
export function validateAlphaSecrets(
  deployment: AlphaDeployment,
  secrets: unknown,
): Array<{ key: string; value: string }> {
  const names = alphaSecretNames(deployment);
  const parsed = z.record(z.string(), z.string()).safeParse(secrets);
  if (!parsed.success) {
    throw new ElizaError("Secrets must be a JSON object of strings", {
      code: "ALPHA_SECRETS_INVALID",
    });
  }
  const provided = Object.keys(parsed.data).sort();
  if (JSON.stringify(provided) !== JSON.stringify(names)) {
    throw new ElizaError(`Secrets must name exactly: ${names.join(", ")}`, {
      code: "ALPHA_SECRETS_INVALID",
    });
  }
  for (const name of ["ELIZA_API_TOKEN", "ELIZA_VAULT_PASSPHRASE"]) {
    if ((parsed.data[name] ?? "").length < 32) {
      throw new ElizaError(`${name} must have at least 32 characters`, {
        code: "ALPHA_SECRETS_INVALID",
      });
    }
  }
  if (names.some((name) => parsed.data[name]?.trim() === "")) {
    throw new ElizaError("Secrets must not be empty", {
      code: "ALPHA_SECRETS_INVALID",
    });
  }
  return names.map((key) => ({ key, value: parsed.data[key] as string }));
}

function measuredEnvironment(
  deployment: AlphaDeployment,
  image: AlphaImageRecord,
  releaseAuthorityPem: string,
): Record<string, string> {
  const embeddings: Record<string, string> =
    deployment.embeddings.provider === "elizacloud"
      ? {
          ELIZAOS_CLOUD_USE_EMBEDDINGS: "true",
          ...(deployment.embeddings.model
            ? { ELIZAOS_CLOUD_EMBEDDING_MODEL: deployment.embeddings.model }
            : {}),
          ...(deployment.embeddings.dimensions
            ? {
                ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: String(
                  deployment.embeddings.dimensions,
                ),
              }
            : {}),
        }
      : {
          ELIZAOS_CLOUD_USE_EMBEDDINGS: "false",
          EMBEDDING_BASE_URL: deployment.embeddings.baseUrl,
          EMBEDDING_MODEL: deployment.embeddings.model,
          EMBEDDING_DIMENSIONS: String(deployment.embeddings.dimensions),
        };
  return {
    NODE_ENV: "production",
    ELIZA_STATE_DIR: ALPHA_STATE_DIR,
    ELIZA_API_BIND: "0.0.0.0",
    ELIZA_API_PORT: String(ALPHA_AGENT_PORT),
    ELIZA_PORT: String(ALPHA_AGENT_PORT),
    // Ingress arrives through the dstack gateway; no caller is a trusted
    // loopback owner, so every API request needs ELIZA_API_TOKEN.
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ELIZA_EXTERNAL_BASE_URL: deployment.publicOrigin,
    // Text: Cerebras only. Eliza Cloud supplies speech (and optionally
    // embeddings) but never text inference.
    ELIZA_PROVIDER: "cerebras",
    CEREBRAS_SMALL_MODEL: deployment.models.small,
    CEREBRAS_LARGE_MODEL: deployment.models.large,
    ELIZAOS_CLOUD_USE_INFERENCE: "false",
    ELIZAOS_CLOUD_USE_TTS: "true",
    ELIZAOS_CLOUD_USE_STT: "true",
    ...(deployment.speech.ttsModel
      ? { ELIZAOS_CLOUD_TTS_MODEL: deployment.speech.ttsModel }
      : {}),
    ...(deployment.speech.ttsVoice
      ? { ELIZAOS_CLOUD_TTS_VOICE: deployment.speech.ttsVoice }
      : {}),
    ...embeddings,
    // Alpha routines (morning brief, reminders, nudge) seed disabled until
    // the owner enables them; they fire in the owner's timezone.
    ELIZA_SCHEDULING_DEFAULT_PACKS: "alpha-routines",
    // Local models disabled: no plugin, no boot-hook registration, no
    // in-process llama loader and no local embedder or warmup.
    ELIZA_SKIP_PLUGINS: "@elizaos/plugin-local-inference",
    ELIZA_DEPLOYMENT_RUNTIME: "cloud",
    ELIZA_DISABLE_LOCAL_EMBEDDINGS: "1",
    ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP: "1",
    ELIZA_DISABLE_FFI_LLAMA: "1",
    // Attestation admission (packages/agent tee-boot-gate, dstack-cpu).
    ELIZA_TEE_PRODUCTION_PROFILE: "dstack-cpu",
    ELIZA_DSTACK_RELEASE_PUBKEY: releaseAuthorityPem,
    ELIZA_DSTACK_EVIDENCE_CONFIG_JSON: JSON.stringify({
      socketPath: ALPHA_DSTACK_SOCKET,
      verifierPath: ALPHA_VERIFIER_PATH,
      verifierSha256: image.verifier.sha256,
      verifierConfigPath: ALPHA_VERIFIER_CONFIG_PATH,
      verifierConfigSha256: image.verifier.configSha256,
      variant: deployment.variant,
    }),
  };
}

/** Docker compose document (JSON is valid compose YAML) measured by dstack. */
export function renderAlphaDockerCompose(
  deployment: AlphaDeployment,
  image: AlphaImageRecord,
  releaseAuthorityPem: string,
): Record<string, unknown> {
  const secrets = alphaSecretNames(deployment);
  const environment: Record<string, string> = {
    ...measuredEnvironment(deployment, image, releaseAuthorityPem),
  };
  for (const name of [...secrets, ...DSTACK_LAUNCH_ENV]) {
    environment[name] = `\${${name}}`;
  }
  const launch = JSON.stringify({
    entry: ENTRY_PATH,
    publicKey: releaseAuthorityPem,
    environmentNames: secrets,
  });
  return {
    services: {
      "eliza-alpha": {
        image: image.image,
        restart: "unless-stopped",
        init: true,
        stop_grace_period: "60s",
        working_dir: "/app",
        // The measured bootstrap authenticates the encrypted launch variables
        // against the signed release before importing any application code.
        entrypoint: [
          "node",
          "--import",
          TSX_LOADER,
          BOOTSTRAP_PATH,
          ALPHA_LAUNCH_CONFIG_PATH,
        ],
        command: [],
        environment,
        configs: [{ source: "alpha-launch", target: ALPHA_LAUNCH_CONFIG_PATH }],
        volumes: [
          `eliza-state:${ALPHA_STATE_DIR}`,
          `${ALPHA_DSTACK_SOCKET}:${ALPHA_DSTACK_SOCKET}`,
        ],
        ports: [`${ALPHA_AGENT_PORT}:${ALPHA_AGENT_PORT}`],
        healthcheck: {
          test: [
            "CMD",
            "curl",
            "-fsS",
            "-o",
            "/dev/null",
            `http://127.0.0.1:${ALPHA_AGENT_PORT}/api/health`,
          ],
          interval: "30s",
          timeout: "10s",
          retries: 5,
          start_period: "180s",
        },
      },
    },
    volumes: { "eliza-state": {} },
    configs: { "alpha-launch": { content: launch } },
  };
}

export interface RenderedAlphaApplication {
  /** Exact app-compose.json bytes; the release signature covers these. */
  appCompose: string;
  composeHash: string;
  appId: string;
  secretNames: string[];
}

export function renderAlphaApplication(
  deploymentInput: unknown,
  imageInput: unknown,
  releaseAuthorityPem: string,
): RenderedAlphaApplication {
  const deployment = alphaDeploymentSchema.parse(deploymentInput);
  const image = alphaImageRecordSchema.parse(imageInput);
  if (!releaseAuthorityPem.startsWith("-----BEGIN PUBLIC KEY-----")) {
    throw new ElizaError("Release authority must be a PEM public key", {
      code: "ALPHA_RELEASE_AUTHORITY_INVALID",
    });
  }
  const secretNames = alphaSecretNames(deployment);
  const appCompose = `${JSON.stringify(
    {
      manifest_version: "3",
      name: `eliza-${deployment.agentId}`,
      runner: "docker-compose",
      docker_compose_file: JSON.stringify(
        renderAlphaDockerCompose(deployment, image, releaseAuthorityPem.trim()),
        null,
        2,
      ),
      kms_enabled: true,
      gateway_enabled: true,
      local_key_provider_enabled: false,
      key_provider: "kms",
      key_provider_id: deployment.kms.keyProviderId,
      public_logs: false,
      public_sysinfo: false,
      public_tcbinfo: true,
      no_instance_id: false,
      secure_time: true,
      storage_discard: false,
      allowed_envs: [...secretNames, ...DSTACK_LAUNCH_ENV].sort(),
      requirements: { platforms: [deployment.variant] },
    },
    null,
    2,
  )}\n`;
  const composeHash = createHash("sha256").update(appCompose).digest("hex");
  return {
    appCompose,
    composeHash,
    // The dstack new-app protocol uses the first 20 bytes of the compose hash.
    appId: composeHash.slice(0, 40),
    secretNames,
  };
}

/** Input accepted by scripts/sign-confidential-release.ts. */
export function alphaReleaseInput(
  deploymentInput: unknown,
  rendered: RenderedAlphaApplication,
) {
  const deployment = alphaDeploymentSchema.parse(deploymentInput);
  return {
    agentId: deployment.agentId,
    compose: rendered.appCompose,
    osImageHash: deployment.osImageHash,
    variant: deployment.variant,
    notBefore: deployment.release.notBefore,
    expiresAt: deployment.release.expiresAt,
  };
}

/** Unsigned processor policy (eliza-confidential-processors-v1) payload. */
export function alphaProcessorPolicy(
  deploymentInput: unknown,
  rendered: RenderedAlphaApplication,
  revision: string,
) {
  const deployment = alphaDeploymentSchema.parse(deploymentInput);
  const cerebras = deployment.processors.cerebras;
  const expiresAt = Math.min(
    Date.parse(deployment.release.expiresAt),
    Date.parse(cerebras.expiresAt),
  );
  return {
    schema: "eliza-confidential-processors-v1",
    agentId: deployment.agentId,
    deploymentId: deployment.deploymentId,
    revision: identifier.parse(revision),
    notBefore: Date.parse(deployment.release.notBefore),
    expiresAt,
    routes: [
      {
        id: "cerebras-text",
        endpoint: cerebras.endpoint,
        model: deployment.models.large,
        modelTypes: ["TEXT_SMALL", "TEXT_LARGE"],
        adapter: "openai-compatible",
        transportIdentity: {
          appId: rendered.appId,
          composeHash: rendered.composeHash,
          osImageHash: deployment.osImageHash,
          variant: deployment.variant,
        },
        processorApproval: {
          provider: "cerebras",
          service: "inference",
          region: cerebras.region,
          contractRef: cerebras.contractRef,
          approvalRef: cerebras.approvalRef,
          expiresAt: Date.parse(cerebras.expiresAt),
        },
      },
    ],
  };
}
