/**
 * Operator CLI for the Alpha dstack deployment (deploy/dstack-alpha/README.md).
 * Run with `bun --conditions=eliza-source packages/app/scripts/alpha-dstack.ts
 * <command>`. Outputs are written exclusively (never overwritten) with mode
 * 0600, and neither secrets nor parser diagnostics that could contain them
 * are printed. API tokens are read from ELIZA_ALPHA_API_TOKEN, never argv.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import {
  buildRemoteAgentPairingUri,
  normalizeRemoteAgentOrigin,
  REMOTE_AGENT_ENDPOINTS,
} from "@elizaos/contracts";
import {
  signAlphaProcessorPolicy,
  verifyAlphaAttestation,
} from "../src/services/alpha-dstack-attestation.ts";
import {
  alphaDeploymentSchema,
  alphaProcessorPolicy,
  alphaReleaseInput,
  renderAlphaApplication,
  validateAlphaSecrets,
} from "../src/services/alpha-dstack-deployment.ts";
import { encryptConfidentialEnvironment } from "../src/services/confidential-environment.ts";

const USAGE = `Usage: alpha-dstack.ts <command> [options]
  render            --deployment F --image F --authority-pub F --out DIR
  encrypt-env       --deployment F --out-dir DIR --secrets F --authority-pub F --launch-key F
  provision-request --deployment F --out-dir DIR
  sign-processors   --deployment F --out-dir DIR --key F --revision ID
  verify-attestation --deployment F --image F --out-dir DIR --authority-pub F
                    --verifier F --verifier-config F --endpoint ORIGIN
  pair-link         --endpoint ORIGIN [--scheme elizaos]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    deployment: { type: "string" },
    image: { type: "string" },
    "authority-pub": { type: "string" },
    out: { type: "string" },
    "out-dir": { type: "string" },
    secrets: { type: "string" },
    "launch-key": { type: "string" },
    key: { type: "string" },
    revision: { type: "string" },
    verifier: { type: "string" },
    "verifier-config": { type: "string" },
    endpoint: { type: "string" },
    scheme: { type: "string" },
  },
});

function need(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}
function absolute(name: keyof typeof values): string {
  const value = need(name);
  if (!isAbsolute(value)) throw new UsageError(`--${name} must be absolute`);
  return value;
}
/** Errors whose messages carry no secret material and may be printed. */
class UsageError extends Error {}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
async function writeNew(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
}
function apiToken(): string {
  const token = process.env.ELIZA_ALPHA_API_TOKEN;
  if (!token) throw new UsageError("Set ELIZA_ALPHA_API_TOKEN");
  return token;
}
function endpoint(): string {
  const origin = normalizeRemoteAgentOrigin(need("endpoint"));
  if (!origin) throw new UsageError("--endpoint must be an HTTPS origin");
  return origin;
}
async function agentJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiToken()}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new UsageError(`Agent returned HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function releaseFiles(outDir: string) {
  return {
    release: await json(`${outDir}/release.json`),
    envelope: (await json(`${outDir}/release.envelope.json`)) as {
      payload: string;
      signature: string;
    },
  };
}

async function main(command: string | undefined): Promise<void> {
  switch (command) {
    case "render": {
      const deployment = await json(absolute("deployment"));
      const rendered = renderAlphaApplication(
        deployment,
        await json(absolute("image")),
        await readFile(absolute("authority-pub"), "utf8"),
      );
      const out = absolute("out");
      await mkdir(out, { recursive: true, mode: 0o700 });
      await writeNew(`${out}/app-compose.json`, rendered.appCompose);
      await writeNew(
        `${out}/release.json`,
        `${JSON.stringify(alphaReleaseInput(deployment, rendered), null, 2)}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({
          appId: rendered.appId,
          composeHash: rendered.composeHash,
          secretNames: rendered.secretNames,
        })}\n`,
      );
      return;
    }
    case "encrypt-env": {
      const deployment = alphaDeploymentSchema.parse(
        await json(absolute("deployment")),
      );
      const outDir = absolute("out-dir");
      const { release, envelope } = await releaseFiles(outDir);
      const environment = validateAlphaSecrets(
        deployment,
        await json(absolute("secrets")),
      );
      const encrypted = await encryptConfidentialEnvironment(
        {
          release,
          envelope,
          endpoint: deployment.kms.envEncryptEndpoint,
          kmsSigningPublicKey: deployment.kms.signingPublicKey,
          environment,
        },
        await readFile(absolute("authority-pub"), "utf8"),
        await readFile(absolute("launch-key"), "utf8"),
      );
      await writeNew(
        `${outDir}/encrypted-env.json`,
        `${JSON.stringify(encrypted)}\n`,
      );
      process.stdout.write("Encrypted environment written.\n");
      return;
    }
    case "provision-request": {
      const deployment = alphaDeploymentSchema.parse(
        await json(absolute("deployment")),
      );
      if (deployment.variant !== "dstack-tdx") {
        throw new UsageError("provision-confidential-vm supports dstack-tdx");
      }
      const outDir = absolute("out-dir");
      const { release, envelope } = await releaseFiles(outDir);
      const encrypted = (await json(`${outDir}/encrypted-env.json`)) as {
        encryptedEnv: string;
      };
      const { compose, notBefore, expiresAt } = release as Record<
        string,
        string
      >;
      await writeNew(
        `${outDir}/provision-request.json`,
        `${JSON.stringify(
          {
            endpoint: deployment.vmm.endpoint,
            agentId: deployment.agentId,
            compose,
            osImageHash: deployment.osImageHash,
            variant: deployment.variant,
            notBefore,
            expiresAt,
            envelope,
            image: deployment.vmm.image,
            vcpu: deployment.vmm.vcpu,
            memory: deployment.vmm.memoryMb,
            diskSize: deployment.vmm.diskGb,
            encryptedEnv: encrypted.encryptedEnv,
            kmsUrls: deployment.kms.urls,
          },
          null,
          2,
        )}\n`,
      );
      process.stdout.write("Provisioning request written.\n");
      return;
    }
    case "sign-processors": {
      const deployment = await json(absolute("deployment"));
      const outDir = absolute("out-dir");
      const { release } = await releaseFiles(outDir);
      const compose = (release as { compose: string }).compose;
      const composeHash = createHash("sha256").update(compose).digest("hex");
      const rendered = {
        appCompose: compose,
        composeHash,
        appId: composeHash.slice(0, 40),
        secretNames: [],
      };
      const envelope = signAlphaProcessorPolicy(
        alphaProcessorPolicy(deployment, rendered, need("revision")),
        await readFile(absolute("key"), "utf8"),
      );
      await writeNew(
        `${outDir}/processors.envelope.json`,
        `${JSON.stringify(envelope)}\n`,
      );
      process.stdout.write("Processor policy signed.\n");
      return;
    }
    case "verify-attestation": {
      const outDir = absolute("out-dir");
      const { release, envelope } = await releaseFiles(outDir);
      const origin = endpoint();
      const result = await verifyAlphaAttestation(
        {
          deployment: await json(absolute("deployment")),
          image: await json(absolute("image")),
          release,
          releaseEnvelope: envelope,
          authorityPublicKeyPem: await readFile(
            absolute("authority-pub"),
            "utf8",
          ),
          processorPolicyPath: `${outDir}/processors.envelope.json`,
          verifierPath: absolute("verifier"),
          verifierConfigPath: absolute("verifier-config"),
        },
        (nonce) =>
          agentJson(`${origin}/api/tee/dstack/attestation`, {
            method: "POST",
            body: JSON.stringify({ nonce }),
          }),
      );
      process.stdout.write(
        `${JSON.stringify({ verified: true, ...result }, null, 2)}\n`,
      );
      return;
    }
    case "pair-link": {
      const origin = endpoint();
      const issued = (await agentJson(
        `${origin}${REMOTE_AGENT_ENDPOINTS.pairCode}`,
        { method: "GET" },
      )) as { code?: string; instanceId?: string; expiresAt?: number };
      process.stdout.write(
        `${buildRemoteAgentPairingUri(
          {
            apiBase: origin,
            code: issued.code ?? "",
            instanceId: issued.instanceId ?? "",
          },
          values.scheme ?? "elizaos",
        )}\n`,
      );
      if (issued.expiresAt) {
        process.stderr.write(
          `Single use; expires ${new Date(issued.expiresAt).toISOString()}.\n`,
        );
      }
      return;
    }
    default:
      throw new UsageError(USAGE);
  }
}

try {
  await main(positionals[0]);
} catch (error) {
  // error-policy:J1 Report only the failing step; parser and crypto
  // diagnostics can contain launch secrets.
  process.stderr.write(
    error instanceof UsageError
      ? `${error.message}\n`
      : `alpha-dstack ${positionals[0] ?? ""} failed: ${
          error instanceof Error && "code" in error
            ? String((error as { code: unknown }).code)
            : "check inputs"
        }\n`,
  );
  process.exitCode = 1;
}
