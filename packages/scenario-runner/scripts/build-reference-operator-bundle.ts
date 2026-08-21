/**
 * Builds the reviewed operator capability entry as one digestable ESM file and
 * optionally emits a complete 13-scenario data-only configuration template.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PROVIDER_CANARY_SCENARIO_IDS } from "../src/provider-qualified/canary-catalog.ts";
import { providerCanaryControllerContract } from "../src/provider-qualified/controller-registry.ts";
import { REFERENCE_OPERATOR_CONFIG_SCHEMA } from "../src/provider-qualified/reference-operator-bundle.ts";

const HELP = `Usage:
  bun scripts/build-reference-operator-bundle.ts --out <provider-capabilities.mjs>
    [--template-out <reference-operator-config.example.json>]

Builds a single ESM bundle. Existing output files are never overwritten.
`;

function fail(message: string): never {
  throw new Error(`reference operator bundle build refused: ${message}`);
}

function parseArgs(argv: readonly string[]): {
  output: string;
  templateOutput?: string;
} {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  let output: string | undefined;
  let templateOutput: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) fail(`${flag ?? "argument"} requires a value`);
    if (flag === "--out" && output === undefined) output = path.resolve(value);
    else if (flag === "--template-out" && templateOutput === undefined)
      templateOutput = path.resolve(value);
    else fail(`unsupported or repeated argument ${flag}`);
  }
  if (!output) fail("--out is required");
  if (output === templateOutput)
    fail("bundle and template outputs must differ");
  return { output, templateOutput };
}

function configurationTemplate(): unknown {
  const placeholderPem =
    "REPLACE_WITH_DEPLOYMENT_OWNED_ED25519_SPKI_PUBLIC_KEY_PEM";
  const placeholderHash = "0".repeat(64);
  const deployments = Object.fromEntries(
    PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId) => {
      const contract = providerCanaryControllerContract(scenarioId);
      return [
        scenarioId,
        {
          scenarioId,
          operationKind: contract.operationKind,
          controllerFamily: contract.controllerFamily,
          controller: {
            endpoint: "https://controller.operator.example/v1/execute",
            administrativeDomain: "controller-operator",
            bearerSecretRef: `provider-canary/${scenarioId}/controller-token`,
          },
          observer: {
            endpoint: "https://observer.independent.example/v1/evidence",
            administrativeDomain: "independent-observer",
            bearerSecretRef: `provider-canary/${scenarioId}/observer-token`,
            organizationId: "independent-observer",
            publicKeyPem: placeholderPem,
            keyId: placeholderHash,
            serviceIdentitySha256: placeholderHash,
          },
          semanticJudge: {
            endpoint: "https://judge.independent.example/v1/evidence",
            administrativeDomain: "independent-judge",
            bearerSecretRef: `provider-canary/${scenarioId}/judge-token`,
            organizationId: "independent-judge",
            publicKeyPem: placeholderPem,
            keyId: placeholderHash,
            serviceIdentitySha256: placeholderHash,
          },
          cleanup: {
            endpoint: "https://cleanup.operator.example/v1/cleanup",
            administrativeDomain: "cleanup-operator",
            bearerSecretRef: `provider-canary/${scenarioId}/cleanup-token`,
            publicKeyPem: placeholderPem,
            keyId: placeholderHash,
          },
          pinnedObserverPublicKeysPem: [placeholderPem],
          pinnedSemanticJudgePublicKeysPem: [placeholderPem],
        },
      ];
    }),
  );
  return {
    schema: REFERENCE_OPERATOR_CONFIG_SCHEMA,
    manifestAuthorityOrganizationId: "manifest-authority",
    secretBrokerEndpoint: "https://secrets.operator.example/v1/resolve",
    deployments,
  };
}

function assertSelfContainedEsm(source: string): void {
  const specifiers = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\bimport\s+["']([^"']+)["']/g),
  ].map((match) => match[1]);
  const unresolved = specifiers.filter(
    (specifier) => specifier !== undefined && !specifier.startsWith("node:"),
  );
  if (unresolved.length > 0) {
    fail(
      `bundle retains unresolved imports: ${[...new Set(unresolved)].join(", ")}`,
    );
  }
  if (!source.includes("createExternalProviderCanaryCapabilities"))
    fail("bundle does not expose the required factory");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(args.output)) fail("bundle output already exists");
  if (args.templateOutput && existsSync(args.templateOutput))
    fail("template output already exists");
  const directory = mkdtempSync(
    path.join(tmpdir(), "eliza-reference-operator-"),
  );
  try {
    const entrypoint = fileURLToPath(
      new URL(
        "../src/provider-qualified/reference-operator-bundle.ts",
        import.meta.url,
      ),
    );
    const result = await Bun.build({
      entrypoints: [entrypoint],
      outdir: directory,
      naming: "provider-capabilities.mjs",
      target: "node",
      format: "esm",
      bundle: true,
      splitting: false,
      minify: false,
      sourcemap: "none",
    });
    if (!result.success) {
      const messages = result.logs.map((log) => log.message).join("; ");
      fail(`Bun build failed${messages ? `: ${messages}` : ""}`);
    }
    const built = path.join(directory, "provider-capabilities.mjs");
    const source = readFileSync(built, "utf8");
    assertSelfContainedEsm(source);
    copyFileSync(built, args.output, 0);
    chmodSync(args.output, 0o644);
    if (args.templateOutput) {
      writeFileSync(
        args.templateOutput,
        `${JSON.stringify(configurationTemplate(), null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    }
    const digest = createHash("sha256").update(source, "utf8").digest("hex");
    process.stdout.write(`${digest}  ${args.output}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
