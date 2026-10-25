import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class GatewayArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayArtifactError";
    this.code = "GATEWAY_ARTIFACT_INVALID";
  }
}

/** Build-time tooling for trusted, host-owned paths and serialized staging.
 * The host pins source identity and owns file selection and provenance publication.
 * A failed stage may leave partial output; verify before packaging or use.
 */
export function verifyGatewayArtifact({
  gatewayDirectory,
  productDirectory,
  sourceDirectory,
  sourceCommit,
  provenance,
  productFiles,
  upstreamFiles,
  dnsDependencies,
  productOutputDirectory = gatewayDirectory,
  verifyMobileDns,
  extraGeneratedFiles = [],
}) {
  const gateway = path.resolve(gatewayDirectory);
  const expectedCommit = sourceCommit;
  if (provenance.commit !== expectedCommit)
    throw new GatewayArtifactError(
      "Android agent source does not match the pinned upstream commit",
    );
  const taskSpec = JSON.parse(
    fs.readFileSync(path.join(gateway, "task-runtime.mjs.json")),
  );
  if (taskSpec.schemaVersion !== 2 || taskSpec.sourceCommit !== expectedCommit)
    throw new GatewayArtifactError(
      "Android task runtime source does not match the pinned upstream commit",
    );
  const hashes = provenance.gatewayHashes;
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (verifyMobileDns) verifyMobileDns(path.join(gateway, "mobile-dns.mjs"));
  else {
    for (const [key, relative] of [
      ["mobileDnsSource", "mobile-dns.ts"],
      ["mobileDnsBudgetSource", "mobile-dns-decode-budget.ts"],
    ]) {
      if (
        hashes?.[key] !==
        hash(
          fs.readFileSync(
            path.join(sourceDirectory, "packages/agent/src/runtime", relative),
          ),
        )
      )
        throw new GatewayArtifactError(
          "Android DNS source does not match the pinned upstream source",
        );
    }
    for (const relative of dnsDependencies) {
      if (
        hashes?.[`dns:${relative}`] !==
        hash(fs.readFileSync(path.join(sourceDirectory, relative)))
      )
        throw new GatewayArtifactError(
          `Android DNS dependency mismatch: ${relative}`,
        );
    }
  }
  for (const relative of upstreamFiles) {
    const expected = hash(
      fs.readFileSync(path.join(sourceDirectory, relative)),
    );
    const staged = path.join(gateway, "../vendor/eliza", relative);
    if (
      hashes?.[`upstream:${relative}`] !== expected ||
      !fs.existsSync(staged) ||
      hash(fs.readFileSync(staged)) !== expected
    )
      throw new GatewayArtifactError(
        `Android shared gateway dependency mismatch: ${relative}`,
      );
  }
  for (const name of productFiles) {
    const current = hash(fs.readFileSync(path.join(productDirectory, name)));
    if (
      hashes?.[name] !== current ||
      hash(fs.readFileSync(path.join(productOutputDirectory, name))) !== current
    ) {
      throw new GatewayArtifactError(
        `Stale Android gateway: ${name}; restage the gateway before packaging`,
      );
    }
  }
  for (const name of [
    "task-runtime.mjs",
    "task-runtime.mjs.json",
    "mobile-dns.mjs",
    "bootstrap.mjs",
    ...extraGeneratedFiles,
  ]) {
    if (
      !hashes?.[name] ||
      hash(fs.readFileSync(path.join(gateway, name))) !== hashes[name]
    ) {
      throw new GatewayArtifactError(
        `Android gateway integrity mismatch: ${name}`,
      );
    }
  }
  return { verifiedProductFiles: productFiles.length };
}

export function stageGatewayArtifact({
  gatewayDirectory,
  productDirectory,
  sourceDirectory,
  productFiles,
  upstreamFiles,
  dnsDependencies,
  buildTaskRuntime,
  environment,
  bunExecutable = "bun",
  productOutputDirectory = gatewayDirectory,
  buildMobileDns,
  gatewayEntrypoint = "./local-agent-gateway.mjs",
  extraGeneratedFiles = [],
  stageAdditionalFiles,
}) {
  const source = path.resolve(sourceDirectory);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const env = environment;
  const gateway = path.resolve(gatewayDirectory);
  fs.mkdirSync(gateway, { recursive: true });
  const hashes = {};
  for (const name of productFiles) {
    const bytes = fs.readFileSync(path.join(productDirectory, name));
    fs.mkdirSync(path.dirname(path.join(productOutputDirectory, name)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(productOutputDirectory, name), bytes);
    hashes[name] = hash(bytes);
  }
  for (const relative of upstreamFiles) {
    const bytes = fs.readFileSync(path.join(source, relative));
    const destination = path.join(gateway, "../vendor/eliza", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    hashes[`upstream:${relative}`] = hash(bytes);
  }
  buildTaskRuntime(path.join(gateway, "task-runtime.mjs"));
  for (const name of ["task-runtime.mjs", "task-runtime.mjs.json"])
    hashes[name] = hash(fs.readFileSync(path.join(gateway, name)));
  if (buildMobileDns) buildMobileDns(path.join(gateway, "mobile-dns.mjs"));
  else {
    const dnsSource = fs.readFileSync(
      path.join(source, "packages/agent/src/runtime/mobile-dns.ts"),
    );
    const budgetSource = fs.readFileSync(
      path.join(
        source,
        "packages/agent/src/runtime/mobile-dns-decode-budget.ts",
      ),
    );
    hashes.mobileDnsSource = hash(dnsSource);
    hashes.mobileDnsBudgetSource = hash(budgetSource);
    for (const relative of dnsDependencies)
      hashes[`dns:${relative}`] = hash(
        fs.readFileSync(path.join(source, relative)),
      );
    // Bundle the reviewed entrypoint and its narrow exported dependencies unchanged.
    execFileSync(
      bunExecutable,
      [
        "build",
        path.join(source, "packages/agent/src/runtime/mobile-dns.ts"),
        "--target=bun",
        "--outfile",
        path.join(gateway, "mobile-dns.mjs"),
      ],
      { cwd: source, env, stdio: "inherit" },
    );
  }
  fs.writeFileSync(
    path.join(gateway, "bootstrap.mjs"),
    `import { configureMobileDnsIfNeeded } from "./mobile-dns.mjs";\nconfigureMobileDnsIfNeeded();\nprocess.argv[1] = new URL(${JSON.stringify(gatewayEntrypoint)}, import.meta.url).pathname;\nawait import(${JSON.stringify(gatewayEntrypoint)});\n`,
  );
  stageAdditionalFiles?.(gateway);
  for (const name of [
    "mobile-dns.mjs",
    "bootstrap.mjs",
    ...extraGeneratedFiles,
  ])
    hashes[name] = hash(fs.readFileSync(path.join(gateway, name)));
  return hashes;
}
