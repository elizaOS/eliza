#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const IMAGE_FIELDS = Object.freeze([
  {
    outputKey: "forgejoImage",
    imageKey: "FORGEJO_IMAGE",
    digestKey: "FORGEJO_IMAGE_DIGEST",
  },
  {
    outputKey: "stewardImage",
    imageKey: "MERGE_STEWARD_IMAGE",
    digestKey: "MERGE_STEWARD_IMAGE_DIGEST",
  },
  {
    outputKey: "runnerImage",
    imageKey: "FORGEJO_RUNNER_IMAGE",
    digestKey: "FORGEJO_RUNNER_IMAGE_DIGEST",
  },
  {
    outputKey: "dindImage",
    imageKey: "FORGEJO_RUNNER_DIND_IMAGE",
    digestKey: "FORGEJO_RUNNER_DIND_IMAGE_DIGEST",
  },
]);

const BOOLEAN_FIELDS = Object.freeze([
  {
    outputKey: "stewardImageBuiltByCi",
    envKey: "IMAGE_PROVENANCE_STEWARD_IMAGE_BUILT_BY_CI",
  },
  {
    outputKey: "stewardImageSignatureVerified",
    envKey: "IMAGE_PROVENANCE_STEWARD_IMAGE_SIGNATURE_VERIFIED",
  },
  {
    outputKey: "sbomGenerated",
    envKey: "IMAGE_PROVENANCE_SBOM_GENERATED",
  },
  {
    outputKey: "vulnerabilityScanClean",
    envKey: "IMAGE_PROVENANCE_VULNERABILITY_SCAN_CLEAN",
  },
]);

const DIGEST_REF_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/i;
const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_IMAGE_PROVENANCE_OUTPUT = artifactPath(
  "image-provenance-audit.json",
);

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
    const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
    const values = readConfiguration(envFile, process.env);
    const errors = [];
    const imageProvenance = {};
    const checkedAt = readCheckedAt(values, errors);

    for (const field of IMAGE_FIELDS) {
      const resolved = resolveImageReference(
        values[field.imageKey],
        values[field.digestKey],
      );

      if (!resolved) {
        errors.push(
          `${field.imageKey} must be an @sha256 reference or be paired with ${field.digestKey}`,
        );
        continue;
      }

      if (!DIGEST_REF_PATTERN.test(resolved)) {
        errors.push(
          `${field.imageKey} must resolve to <image>@sha256:<64 hex chars>`,
        );
        continue;
      }

      imageProvenance[field.outputKey] = resolved;
    }

    for (const field of BOOLEAN_FIELDS) {
      const parsed = parseBoolean(values[field.envKey]);

      if (parsed === undefined) {
        errors.push(`${field.envKey} must be true or false when set`);
        continue;
      }

      imageProvenance[field.outputKey] = parsed ?? false;
    }

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[image-provenance] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const audit = imageProvenanceAudit(imageProvenance, checkedAt);
    const outputPath =
      options.provenanceOutput ??
      values.IMAGE_PROVENANCE_PROVENANCE_OUTPUT ??
      DEFAULT_IMAGE_PROVENANCE_OUTPUT;
    writeImageProvenanceArtifact(outputPath, audit);
    imageProvenance.provenanceEvidence = {
      source: outputPath,
      sha256: sha256File(outputPath),
      checkedAt,
      imageCount: IMAGE_FIELDS.length,
      checkCount: audit.checks.length,
    };

    process.stdout.write(`${JSON.stringify({ imageProvenance }, null, 2)}\n`);
  } catch (error) {
    console.error(`[image-provenance] error: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--env-file") {
      index += 1;
      if (!args[index]) {
        throw new Error("--env-file requires a path");
      }
      options.envFile = args[index];
      continue;
    }

    if (arg.startsWith("--env-file=")) {
      options.envFile = arg.slice("--env-file=".length);
      if (!options.envFile) {
        throw new Error("--env-file requires a path");
      }
      continue;
    }

    if (arg === "--provenance-output") {
      index += 1;
      if (!args[index]) {
        throw new Error("--provenance-output requires a path");
      }
      options.provenanceOutput = args[index];
      continue;
    }

    if (arg.startsWith("--provenance-output=")) {
      options.provenanceOutput = arg.slice("--provenance-output=".length);
      if (!options.provenanceOutput) {
        throw new Error("--provenance-output requires a path");
      }
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function readConfiguration(envFile, processEnv) {
  const fileValues = readEnvFile(envFile, processEnv.ALLOW_ENV_ONLY);
  const values = { ...fileValues };

  for (const key of inputKeys()) {
    if (processEnv[key] !== undefined) {
      values[key] = processEnv[key];
    }
  }

  return values;
}

function readEnvFile(envFile, allowEnvOnly) {
  if (!existsSync(envFile)) {
    if (parseBoolean(allowEnvOnly) === true) {
      return {};
    }
    throw new Error(
      `missing ENV_FILE=${envFile}; set ENV_FILE or ALLOW_ENV_ONLY=true`,
    );
  }

  return parseEnv(readFileSync(envFile, "utf8"));
}

function inputKeys() {
  return [
    ...IMAGE_FIELDS.flatMap((field) => [field.imageKey, field.digestKey]),
    ...BOOLEAN_FIELDS.map((field) => field.envKey),
    "IMAGE_PROVENANCE_CHECKED_AT",
    "IMAGE_PROVENANCE_PROVENANCE_OUTPUT",
  ];
}

function parseEnv(body) {
  const values = {};

  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    values[match[1]] = parseEnvValue(match[2]);
  }

  return values;
}

function parseEnvValue(rawValue) {
  const value = rawValue.trimStart();

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }

  if (value.startsWith('"')) {
    const end = findClosingDoubleQuote(value);
    const quoted = end === -1 ? value.slice(1) : value.slice(1, end);
    return quoted.replace(/\\([\\nrt"])/gu, (_, escaped) => {
      switch (escaped) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return escaped;
      }
    });
  }

  return value.replace(/[ \t]+#.*$/u, "").trimEnd();
}

function findClosingDoubleQuote(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }

    if (value[index] === '"') {
      return index;
    }
  }

  return -1;
}

function resolveImageReference(imageValue, digestValue) {
  const image = cleanValue(imageValue);

  if (!image) {
    return null;
  }

  if (image.includes("@")) {
    return image;
  }

  const digest = normalizeDigest(digestValue);
  if (!digest) {
    return null;
  }

  return `${imageNameWithoutTag(image)}@${digest}`;
}

function normalizeDigest(value) {
  const digest = cleanValue(value);

  if (!digest) {
    return null;
  }

  if (/^[a-f0-9]{64}$/i.test(digest)) {
    return `sha256:${digest}`;
  }

  return digest;
}

function imageNameWithoutTag(image) {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");

  if (lastColon > lastSlash) {
    return image.slice(0, lastColon);
  }

  return image;
}

function readCheckedAt(values, errors) {
  const raw = cleanValue(values.IMAGE_PROVENANCE_CHECKED_AT);
  if (!raw) {
    return new Date().toISOString();
  }

  const normalized = normalizeIso(raw);
  if (!normalized) {
    errors.push(
      "IMAGE_PROVENANCE_CHECKED_AT must be an ISO timestamp when set",
    );
    return new Date().toISOString();
  }

  return normalized;
}

function imageProvenanceAudit(imageProvenance, checkedAt) {
  const images = Object.fromEntries(
    IMAGE_FIELDS.map((field) => [
      field.outputKey,
      imageProvenance[field.outputKey],
    ]),
  );
  const evidence = Object.fromEntries(
    BOOLEAN_FIELDS.map((field) => [
      field.outputKey,
      imageProvenance[field.outputKey],
    ]),
  );
  const checks = [
    check(
      "images_digest_pinned",
      Object.values(images).every((image) => DIGEST_REF_PATTERN.test(image)),
    ),
    ...BOOLEAN_FIELDS.map((field) =>
      check(field.outputKey, imageProvenance[field.outputKey] === true),
    ),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt,
    status: productionReady ? "verified" : "incomplete",
    productionReady,
    images,
    evidence,
    checks,
  };
}

function check(name, passed) {
  return {
    name,
    status: passed ? "pass" : "fail",
  };
}

function writeImageProvenanceArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ imageProvenanceAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function normalizeIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function parseBoolean(value) {
  const normalized = cleanValue(value);

  if (normalized === null) {
    return null;
  }

  if (TRUE_PATTERN.test(normalized)) {
    return true;
  }

  if (FALSE_PATTERN.test(normalized)) {
    return false;
  }

  return undefined;
}

function usage() {
  return `Usage: image-provenance-evidence.mjs [--env-file PATH]
                                     [--provenance-output PATH]

Prints a production evidence imageProvenance block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced.

Image inputs:
  FORGEJO_IMAGE plus optional FORGEJO_IMAGE_DIGEST
  MERGE_STEWARD_IMAGE plus optional MERGE_STEWARD_IMAGE_DIGEST
  FORGEJO_RUNNER_IMAGE plus optional FORGEJO_RUNNER_IMAGE_DIGEST
  FORGEJO_RUNNER_DIND_IMAGE plus optional FORGEJO_RUNNER_DIND_IMAGE_DIGEST

Each image must already include @sha256:<64 hex chars>, or its matching digest
variable must provide sha256:<64 hex chars>. Bare 64-character hex digests are
accepted and normalized.

Non-secret attestation booleans default to false unless set:
  IMAGE_PROVENANCE_STEWARD_IMAGE_BUILT_BY_CI
  IMAGE_PROVENANCE_STEWARD_IMAGE_SIGNATURE_VERIFIED
  IMAGE_PROVENANCE_SBOM_GENERATED
  IMAGE_PROVENANCE_VULNERABILITY_SCAN_CLEAN

IMAGE_PROVENANCE_CHECKED_AT may set the audit timestamp for reproducible
release evidence. The helper writes a retained local audit artifact to
IMAGE_PROVENANCE_PROVENANCE_OUTPUT, --provenance-output, or
$ELIZA_ARTIFACT_ROOT/image-provenance-audit.json by default, then emits its
SHA-256 in imageProvenance.provenanceEvidence.
`;
}
