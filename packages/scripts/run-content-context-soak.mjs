#!/usr/bin/env bun
/** Produces private six-family soak evidence through an operator-supplied production factory module. */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  PROGRESSIVE_CONTENT_SOAK_FAMILIES,
  runProgressiveContentMixedSoak,
} from "../core/src/testing/progressive-content-mixed-soak.ts";

export const CONTENT_CONTEXT_SOAK_FACTORY_SCHEMA_VERSION =
  "elizaos.content-context.soak-factories.v1";

export class ContentContextSoakConfigurationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ContentContextSoakConfigurationError";
    this.code = code;
  }
}

export function parseSoakArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith("--factory-module="))
      options.factoryModule = arg.slice(17);
    else if (arg.startsWith("--corpus-manifest="))
      options.corpusManifest = arg.slice(18);
    else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice(9);
    else
      throw new ContentContextSoakConfigurationError(
        "SOAK_ARGUMENT_UNSUPPORTED",
        `unsupported soak argument: ${arg}`,
      );
  }
  for (const key of ["factoryModule", "corpusManifest", "out", "commit"]) {
    if (!options[key])
      throw new ContentContextSoakConfigurationError(
        "SOAK_ARGUMENT_REQUIRED",
        `--${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`,
      );
  }
  return options;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function validateSoakFactoryModule(value) {
  if (
    !plainObject(value) ||
    value.schemaVersion !== CONTENT_CONTEXT_SOAK_FACTORY_SCHEMA_VERSION ||
    value.production !== true ||
    !Array.isArray(value.targets) ||
    typeof value.measureResources !== "function"
  )
    throw new ContentContextSoakConfigurationError(
      "SOAK_FACTORY_CONTRACT_INVALID",
      "soak factory module must declare the v1 production contract, targets, and resource sampler",
    );
  const families = new Set();
  const adapterIds = new Set();
  const realizations = {
    file: ["filesystem", "native-bytes"],
    document: ["document-store", "typed-rejection"],
    memory: ["memory-store", "typed-rejection"],
    email: ["message-store", "typed-rejection"],
    attachment: ["content-addressed-media", "native-bytes"],
    "tool-output": ["filesystem", "native-bytes"],
  };
  for (const target of value.targets) {
    const realization = plainObject(target)
      ? realizations[target.family]
      : null;
    if (
      !plainObject(target) ||
      !PROGRESSIVE_CONTENT_SOAK_FAMILIES.includes(target.family) ||
      families.has(target.family) ||
      typeof target.adapterId !== "string" ||
      !target.adapterId ||
      /(?:fixture|mock|stub|test)/iu.test(target.adapterId) ||
      adapterIds.has(target.adapterId) ||
      !realization ||
      target.authoritativeStore !== realization[0] ||
      target.binaryPolicy !== realization[1] ||
      typeof target.productionMethod !== "string" ||
      !target.productionMethod ||
      /(?:fixture|mock|stub|test)/iu.test(target.productionMethod) ||
      typeof target.create !== "function"
    )
      throw new ContentContextSoakConfigurationError(
        "SOAK_FACTORY_TARGET_INVALID",
        "soak factories require exact families and unique non-fixture adapterIds",
      );
    families.add(target.family);
    adapterIds.add(target.adapterId);
  }
  if (
    value.targets.length !== PROGRESSIVE_CONTENT_SOAK_FAMILIES.length ||
    PROGRESSIVE_CONTENT_SOAK_FAMILIES.some((family) => !families.has(family))
  )
    throw new ContentContextSoakConfigurationError(
      "SOAK_FACTORY_COVERAGE_INVALID",
      "soak factory module must cover each required family exactly once",
    );
  return {
    targets: value.targets.map((target) => ({
      family: target.family,
      authoritativeStore: target.authoritativeStore,
      productionMethod: target.productionMethod,
      binaryPolicy: target.binaryPolicy,
      async create() {
        const realized = await target.create();
        if (
          !plainObject(realized) ||
          !plainObject(realized.adapter) ||
          realized.adapter.adapterId !== target.adapterId ||
          /(?:fixture|mock|stub|test)/iu.test(realized.adapter.adapterId)
        )
          throw new ContentContextSoakConfigurationError(
            "SOAK_FACTORY_REALIZATION_INVALID",
            `${target.family} factory did not realize its declared production adapter`,
          );
        return realized;
      },
    })),
    measureResources: value.measureResources,
  };
}

async function readPrivateRegular(file, label) {
  let handle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw new ContentContextSoakConfigurationError(
      "SOAK_INPUT_UNAVAILABLE",
      `${label} is unavailable: ${file}`,
      { cause: error },
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
      throw new ContentContextSoakConfigurationError(
        "SOAK_INPUT_UNSAFE",
        `${label} must be a private, regular, singly linked file`,
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function atomicPrivateWrite(file, bytes) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export async function produceContentContextSoak(options) {
  if (!/^[0-9a-f]{40}$/u.test(options.commit))
    throw new ContentContextSoakConfigurationError(
      "SOAK_COMMIT_INVALID",
      "--commit must be a full lowercase Git SHA",
    );
  const manifestBytes = await readPrivateRegular(
    path.resolve(options.corpusManifest),
    "corpus manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new ContentContextSoakConfigurationError(
      "SOAK_CORPUS_MANIFEST_INVALID",
      "corpus manifest is not valid JSON",
      { cause: error },
    );
  }
  if (
    !plainObject(manifest) ||
    !/^[0-9a-f]{64}$/u.test(manifest.manifestSha256)
  )
    throw new ContentContextSoakConfigurationError(
      "SOAK_CORPUS_MANIFEST_INVALID",
      "corpus manifest lacks its canonical SHA-256 identity",
    );
  const modulePath = path.resolve(options.factoryModule);
  await readPrivateRegular(modulePath, "production factory module");
  let imported;
  try {
    imported = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new ContentContextSoakConfigurationError(
      "SOAK_FACTORY_MODULE_UNAVAILABLE",
      `production factory module could not be loaded: ${modulePath}`,
      { cause: error },
    );
  }
  const contract = validateSoakFactoryModule(imported.default ?? imported);
  const report = await runProgressiveContentMixedSoak({
    commit: options.commit,
    corpusManifestSha256: manifest.manifestSha256,
    targets: contract.targets,
    measureResources: contract.measureResources,
  });
  if (!report.evidenceEligible || report.status !== "passed")
    throw new ContentContextSoakConfigurationError(
      "SOAK_RUN_FAILED",
      `production soak did not pass: ${report.failures.join("; ")}`,
    );
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  await atomicPrivateWrite(path.resolve(options.out), bytes);
  return {
    outputSha256: createHash("sha256").update(bytes).digest("hex"),
    report,
  };
}

if (import.meta.main) {
  try {
    const result = await produceContentContextSoak(
      parseSoakArgs(process.argv.slice(2)),
    );
    process.stdout.write(
      `${JSON.stringify({ outputSha256: result.outputSha256 })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error?.code ?? "SOAK_FAILED"}: ${error?.message ?? String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
