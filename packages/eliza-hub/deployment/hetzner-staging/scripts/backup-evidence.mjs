#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactPath, prepareParent } from "./artifact-paths.mjs";

const BACKUP_COMPONENTS = Object.freeze([
  "repositories",
  "database",
  "attachments",
  "packages",
  "lfs",
  "configuration",
]);

const CONFIG_KEYS = Object.freeze([
  "BACKUP_EVIDENCE_BACKUP_DIR",
  "BACKUP_EVIDENCE_OFFSITE_UPLOAD_RECEIPT",
  "BACKUP_EVIDENCE_OFFSITE_RESTORE_RECEIPT",
  "BACKUP_EVIDENCE_SCHEDULED",
  "BACKUP_EVIDENCE_AUDIT_OUTPUT",
  "BACKUP_EVIDENCE_NOW",
]);

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_BACKUP_AUDIT_OUTPUT = artifactPath("backup-audit.json");

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
    const backupDir = cleanValue(
      options.backupDir ??
        process.env.BACKUP_DIR ??
        process.env.RESTORE_BACKUP_DIR ??
        values.BACKUP_EVIDENCE_BACKUP_DIR,
    );
    const inspected =
      backupDir === null ? null : inspectBackupDir(backupDir, errors);
    const uploadReceiptPath = cleanValue(
      options.offsiteUploadReceipt ??
        values.BACKUP_EVIDENCE_OFFSITE_UPLOAD_RECEIPT,
    );
    const restoreReceiptPath = cleanValue(
      options.offsiteRestoreReceipt ??
        values.BACKUP_EVIDENCE_OFFSITE_RESTORE_RECEIPT,
    );
    const offsiteUpload =
      uploadReceiptPath === null
        ? null
        : inspectOffsiteUploadReceipt(
            uploadReceiptPath,
            backupDir,
            inspected,
            errors,
          );
    const offsiteRestore =
      restoreReceiptPath === null
        ? null
        : inspectOffsiteRestoreReceipt(
            restoreReceiptPath,
            offsiteUpload,
            errors,
          );
    const scheduled =
      readBooleanAttestation(values, "BACKUP_EVIDENCE_SCHEDULED", errors) ??
      false;
    const now = readNow(values, errors);
    const backups = {
      scheduled,
      offHost: offsiteUpload?.verified === true,
      encrypted:
        offsiteUpload?.verified === true &&
        offsiteUpload.encryptionFormat === "age",
      lastBackupAt:
        offsiteUpload?.backupCreatedAt ?? inspected?.createdAt ?? null,
      lastRestoreCheckAt: offsiteRestore?.checkedAt ?? null,
      includes: inspected?.includes ?? [],
    };

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[backup-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    const audit = backupAudit({
      backups,
      inspected,
      backupDir,
      offsiteUpload,
      offsiteRestore,
      checkedAt: now,
    });
    const outputPath =
      options.auditOutput ??
      values.BACKUP_EVIDENCE_AUDIT_OUTPUT ??
      DEFAULT_BACKUP_AUDIT_OUTPUT;
    writeBackupAuditArtifact(outputPath, audit);
    backups.backupEvidence = {
      source: outputPath,
      sha256: sha256File(outputPath),
      checkedAt: now,
      status: audit.status,
      productionReady: audit.productionReady,
      backupCreatedAt: backups.lastBackupAt,
      restoreCheckedAt: backups.lastRestoreCheckAt,
      componentCount: backups.includes.length,
      checkCount: audit.checks.length,
      offsiteUploadReceipt: offsiteUpload,
      offsiteRestoreReceipt: offsiteRestore,
    };

    process.stdout.write(`${JSON.stringify({ backups }, null, 2)}\n`);
  } catch (error) {
    console.error(`[backup-evidence] error: ${error.message}`);
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

    if (arg === "--backup-dir") {
      index += 1;
      if (!args[index]) {
        throw new Error("--backup-dir requires a path");
      }
      options.backupDir = args[index];
      continue;
    }

    if (arg.startsWith("--backup-dir=")) {
      options.backupDir = arg.slice("--backup-dir=".length);
      if (!options.backupDir) {
        throw new Error("--backup-dir requires a path");
      }
      continue;
    }

    if (arg === "--offsite-upload-receipt") {
      index += 1;
      if (!args[index]) {
        throw new Error("--offsite-upload-receipt requires a path");
      }
      options.offsiteUploadReceipt = args[index];
      continue;
    }

    if (arg.startsWith("--offsite-upload-receipt=")) {
      options.offsiteUploadReceipt = arg.slice(
        "--offsite-upload-receipt=".length,
      );
      if (!options.offsiteUploadReceipt) {
        throw new Error("--offsite-upload-receipt requires a path");
      }
      continue;
    }

    if (arg === "--offsite-restore-receipt") {
      index += 1;
      if (!args[index]) {
        throw new Error("--offsite-restore-receipt requires a path");
      }
      options.offsiteRestoreReceipt = args[index];
      continue;
    }

    if (arg.startsWith("--offsite-restore-receipt=")) {
      options.offsiteRestoreReceipt = arg.slice(
        "--offsite-restore-receipt=".length,
      );
      if (!options.offsiteRestoreReceipt) {
        throw new Error("--offsite-restore-receipt requires a path");
      }
      continue;
    }

    if (arg === "--audit-output") {
      index += 1;
      if (!args[index]) {
        throw new Error("--audit-output requires a path");
      }
      options.auditOutput = args[index];
      continue;
    }

    if (arg.startsWith("--audit-output=")) {
      options.auditOutput = arg.slice("--audit-output=".length);
      if (!options.auditOutput) {
        throw new Error("--audit-output requires a path");
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
  return CONFIG_KEYS;
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

function inspectBackupDir(backupDir, errors) {
  if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) {
    errors.push(`backup directory not found: ${backupDir}`);
    return { createdAt: null, includes: [] };
  }

  const requiredFiles = [
    "MANIFEST.txt",
    "SHA256SUMS",
    "env.keys",
    "host/compose.yml",
    "host/.env.example",
    "postgres/pg_dumpall.sql",
  ];

  for (const file of requiredFiles) {
    requireBackupFile(backupDir, file, errors);
  }

  const manifest = readBackupText(backupDir, "MANIFEST.txt", errors);
  const createdAt = parseManifestCreatedAt(manifest, errors);
  const includes = inferIncludes(backupDir);

  const checksumCount = verifyChecksums(backupDir, errors);
  const postgresDumpVerified = verifyPostgresDump(backupDir, errors);

  return {
    createdAt,
    includes,
    checksumCount,
    requiredFileCount: requiredFiles.length,
    postgresDumpVerified,
  };
}

function inspectOffsiteUploadReceipt(
  receiptPath,
  backupDir,
  inspected,
  errors,
) {
  const errorCount = errors.length;
  const receipt = readJsonReceipt(
    receiptPath,
    "off-site upload receipt",
    errors,
  );

  if (receipt === null) {
    return null;
  }

  const checkedAt = normalizeIsoDate(
    receipt.checkedAt,
    "off-site upload receipt checkedAt",
    errors,
  );
  const backupName = requiredReceiptString(
    receipt.backupName,
    "off-site upload receipt backupName",
    errors,
  );
  const backupCreatedAt = normalizeIsoDate(
    receipt.backupCreatedAt,
    "off-site upload receipt backupCreatedAt",
    errors,
  );
  const remoteArchive = requiredReceiptString(
    receipt.remoteArchive,
    "off-site upload receipt remoteArchive",
    errors,
  );
  const remoteReceipt = requiredReceiptString(
    receipt.remoteReceipt,
    "off-site upload receipt remoteReceipt",
    errors,
  );
  const ciphertextSha256 = requiredReceiptSha256(
    receipt.ciphertext?.sha256,
    "off-site upload receipt ciphertext.sha256",
    errors,
  );
  const ciphertextBytes = requiredPositiveInteger(
    receipt.ciphertext?.bytes,
    "off-site upload receipt ciphertext.bytes",
    errors,
  );
  const encryptionFormat = requiredReceiptString(
    receipt.encryption?.format,
    "off-site upload receipt encryption.format",
    errors,
  );
  const recipientsFileSha256 = requiredReceiptSha256(
    receipt.encryption?.recipientsFileSha256,
    "off-site upload receipt encryption.recipientsFileSha256",
    errors,
  );
  const verificationMethod = requiredReceiptString(
    receipt.verificationMethod,
    "off-site upload receipt verificationMethod",
    errors,
  );

  if (
    receipt.schema !== "https://eliza.hub/schemas/offsite-backup-receipt.v1"
  ) {
    errors.push("off-site upload receipt schema is unsupported");
  }
  if (receipt.status !== "verified" || receipt.uploadVerified !== true) {
    errors.push("off-site upload receipt must be verified");
  }
  if (encryptionFormat !== "age") {
    errors.push("off-site upload receipt must use age encryption");
  }
  if (verificationMethod !== "download_sha256") {
    errors.push(
      "off-site upload receipt must verify a streamed download by SHA-256",
    );
  }
  if (!/^[a-zA-Z0-9._-]+:.+/u.test(remoteArchive ?? "")) {
    errors.push("off-site upload receipt remoteArchive must be an rclone path");
  }
  if (!/^[a-zA-Z0-9._-]+:.+/u.test(remoteReceipt ?? "")) {
    errors.push("off-site upload receipt remoteReceipt must be an rclone path");
  }
  if (
    remoteArchive?.includes("\n") ||
    remoteArchive?.includes("\r") ||
    remoteReceipt?.includes("\n") ||
    remoteReceipt?.includes("\r")
  ) {
    errors.push(
      "off-site upload receipt remote paths must not contain newlines",
    );
  }
  if (
    remoteArchive !== null &&
    backupName !== null &&
    path.posix.basename(remoteArchive) !== `${backupName}.tar.gz.age`
  ) {
    errors.push("off-site upload receipt remote archive must match backupName");
  }
  if (
    remoteArchive !== null &&
    remoteReceipt !== null &&
    remoteReceipt !== `${path.posix.dirname(remoteArchive)}/receipt.json`
  ) {
    errors.push(
      "off-site upload receipt remote archive and receipt must share a backup directory",
    );
  }
  if (backupDir !== null && backupName !== path.basename(backupDir)) {
    errors.push(
      "off-site upload receipt backupName must match the inspected backup directory",
    );
  }
  if (inspected?.createdAt && backupCreatedAt !== inspected.createdAt) {
    errors.push(
      "off-site upload receipt backupCreatedAt must match MANIFEST.txt",
    );
  }
  if (
    checkedAt !== null &&
    backupCreatedAt !== null &&
    Date.parse(checkedAt) < Date.parse(backupCreatedAt)
  ) {
    errors.push(
      "off-site upload receipt checkedAt must not predate the backup",
    );
  }
  if (backupDir !== null) {
    requireReceiptFileSha(
      receipt.sourceManifestSha256,
      path.join(backupDir, "MANIFEST.txt"),
      "off-site upload receipt sourceManifestSha256",
      errors,
    );
    requireReceiptFileSha(
      receipt.sourceChecksumsSha256,
      path.join(backupDir, "SHA256SUMS"),
      "off-site upload receipt sourceChecksumsSha256",
      errors,
    );
  }

  return {
    source: receiptPath,
    sha256: sha256File(receiptPath),
    checkedAt,
    status: receipt.status,
    backupName,
    backupCreatedAt,
    remoteArchive,
    remoteReceipt,
    ciphertextSha256,
    ciphertextBytes,
    encryptionFormat,
    recipientsFileSha256,
    verificationMethod,
    verified: errors.length === errorCount,
  };
}

function inspectOffsiteRestoreReceipt(receiptPath, upload, errors) {
  const errorCount = errors.length;
  const receipt = readJsonReceipt(
    receiptPath,
    "off-site restore receipt",
    errors,
  );

  if (receipt === null) {
    return null;
  }

  const checkedAt = normalizeIsoDate(
    receipt.checkedAt,
    "off-site restore receipt checkedAt",
    errors,
  );
  const backupName = requiredReceiptString(
    receipt.backupName,
    "off-site restore receipt backupName",
    errors,
  );
  const remoteArchive = requiredReceiptString(
    receipt.remoteArchive,
    "off-site restore receipt remoteArchive",
    errors,
  );
  const remoteReceipt = requiredReceiptString(
    receipt.remoteReceipt,
    "off-site restore receipt remoteReceipt",
    errors,
  );
  const uploadReceiptSha256 = requiredReceiptSha256(
    receipt.uploadReceiptSha256,
    "off-site restore receipt uploadReceiptSha256",
    errors,
  );
  const ciphertextSha256 = requiredReceiptSha256(
    receipt.ciphertext?.sha256,
    "off-site restore receipt ciphertext.sha256",
    errors,
  );
  const ciphertextBytes = requiredPositiveInteger(
    receipt.ciphertext?.bytes,
    "off-site restore receipt ciphertext.bytes",
    errors,
  );

  if (
    receipt.schema !== "https://eliza.hub/schemas/offsite-restore-receipt.v1"
  ) {
    errors.push("off-site restore receipt schema is unsupported");
  }
  if (receipt.status !== "verified") {
    errors.push("off-site restore receipt must be verified");
  }
  for (const field of [
    "downloadVerified",
    "decryptionVerified",
    "archivePathsVerified",
    "structuralRestoreCheckPassed",
  ]) {
    if (receipt[field] !== true) {
      errors.push(`off-site restore receipt ${field} must be true`);
    }
  }
  if (upload === null) {
    errors.push("off-site restore receipt requires an off-site upload receipt");
  } else {
    if (backupName !== upload.backupName) {
      errors.push(
        "off-site restore receipt backupName must match the upload receipt",
      );
    }
    const expectedArchiveName = `${backupName}.tar.gz.age`;
    if (
      path.posix.basename(upload.remoteArchive ?? "") !== expectedArchiveName
    ) {
      errors.push(
        "off-site restore receipt backupName does not match the upload archive",
      );
    }
    if (
      remoteArchive !== upload.remoteArchive ||
      remoteReceipt !== upload.remoteReceipt
    ) {
      errors.push(
        "off-site restore receipt remote paths must match the upload receipt",
      );
    }
    if (uploadReceiptSha256 !== upload.sha256) {
      errors.push(
        "off-site restore receipt uploadReceiptSha256 must match the upload receipt",
      );
    }
    if (
      ciphertextSha256 !== upload.ciphertextSha256 ||
      ciphertextBytes !== upload.ciphertextBytes
    ) {
      errors.push(
        "off-site restore receipt ciphertext must match the upload receipt",
      );
    }
    if (
      checkedAt !== null &&
      upload.checkedAt !== null &&
      Date.parse(checkedAt) < Date.parse(upload.checkedAt)
    ) {
      errors.push(
        "off-site restore receipt checkedAt must not predate the upload receipt",
      );
    }
  }

  return {
    source: receiptPath,
    sha256: sha256File(receiptPath),
    checkedAt,
    status: receipt.status,
    remoteArchive,
    remoteReceipt,
    uploadReceiptSha256,
    ciphertextSha256,
    ciphertextBytes,
    downloadVerified: receipt.downloadVerified === true,
    decryptionVerified: receipt.decryptionVerified === true,
    archivePathsVerified: receipt.archivePathsVerified === true,
    structuralRestoreCheckPassed: receipt.structuralRestoreCheckPassed === true,
    verified: errors.length === errorCount,
  };
}

function readJsonReceipt(receiptPath, label, errors) {
  if (!existsSync(receiptPath) || !statSync(receiptPath).isFile()) {
    errors.push(`${label} not found: ${receiptPath}`);
    return null;
  }

  try {
    const value = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      errors.push(`${label} must contain a JSON object`);
      return null;
    }
    return value;
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function requiredReceiptString(value, label, errors) {
  const normalized = cleanValue(value);
  if (normalized === null) {
    errors.push(`${label} is required`);
  }
  return normalized;
}

function requiredReceiptSha256(value, label, errors) {
  const normalized = requiredReceiptString(value, label, errors);
  if (normalized !== null && !/^[a-f0-9]{64}$/u.test(normalized)) {
    errors.push(`${label} must be a lowercase SHA-256 digest`);
    return null;
  }
  return normalized;
}

function requiredPositiveInteger(value, label, errors) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${label} must be a positive integer`);
    return null;
  }
  return value;
}

function requireReceiptFileSha(value, filePath, label, errors) {
  const digest = requiredReceiptSha256(value, label, errors);
  if (digest !== null && digest !== sha256File(filePath)) {
    errors.push(`${label} must match ${path.basename(filePath)}`);
  }
}

function requireBackupFile(backupDir, relativePath, errors) {
  const target = path.join(backupDir, relativePath);

  if (!existsSync(target) || !statSync(target).isFile()) {
    errors.push(`missing backup file: ${relativePath}`);
  }
}

function readBackupText(backupDir, relativePath, errors) {
  const target = path.join(backupDir, relativePath);

  if (!existsSync(target)) {
    return "";
  }

  try {
    return readFileSync(target, "utf8");
  } catch (error) {
    errors.push(`cannot read ${relativePath}: ${error.message}`);
    return "";
  }
}

function parseManifestCreatedAt(manifest, errors) {
  const match = /^created_utc=(\d{8}T\d{6}Z)$/mu.exec(manifest);

  if (!match) {
    errors.push("MANIFEST.txt must contain created_utc=YYYYMMDDTHHMMSSZ");
    return null;
  }

  const value = match[1];
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`;
  return normalizeIsoDate(iso, "MANIFEST.txt created_utc", errors);
}

function inferIncludes(backupDir) {
  const includes = new Set();

  if (existsSync(path.join(backupDir, "postgres/pg_dumpall.sql"))) {
    includes.add("database");
  }

  if (existsSync(path.join(backupDir, "archives/forgejo-data.tar.gz"))) {
    includes.add("repositories");
    includes.add("attachments");
    includes.add("packages");
    includes.add("lfs");
  }

  if (
    existsSync(path.join(backupDir, "archives/forgejo-config.tar.gz")) &&
    existsSync(path.join(backupDir, "host/compose.yml")) &&
    existsSync(path.join(backupDir, "host/.env.example"))
  ) {
    includes.add("configuration");
  }

  return BACKUP_COMPONENTS.filter((component) => includes.has(component));
}

function verifyChecksums(backupDir, errors) {
  const body = readBackupText(backupDir, "SHA256SUMS", errors);

  if (body.trim() === "") {
    errors.push("SHA256SUMS must not be empty");
    return 0;
  }

  let checksumCount = 0;
  for (const line of body.split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }

    const match = /^([a-fA-F0-9]{64})\s+(.+)$/u.exec(line);
    if (!match) {
      errors.push("SHA256SUMS contains a malformed checksum line");
      continue;
    }

    const expected = match[1].toLowerCase();
    const relativePath = normalizeChecksumPath(match[2]);

    if (relativePath === null) {
      errors.push("SHA256SUMS contains an unsafe file path");
      continue;
    }

    const target = path.join(backupDir, relativePath);
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`SHA256SUMS references a missing file: ${relativePath}`);
      continue;
    }

    const actual = createHash("sha256")
      .update(readFileSync(target))
      .digest("hex");
    if (actual !== expected) {
      errors.push(`checksum mismatch for ${relativePath}`);
      continue;
    }

    checksumCount += 1;
  }

  return checksumCount;
}

function normalizeChecksumPath(value) {
  const relativePath = value
    .trim()
    .replace(/^\*\s*/u, "")
    .replace(/^\.\//u, "");
  const normalized = path.posix.normalize(relativePath.replace(/\\/gu, "/"));

  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return normalized;
}

function verifyPostgresDump(backupDir, errors) {
  const dump = readBackupText(backupDir, "postgres/pg_dumpall.sql", errors);

  if (!/PostgreSQL database (?:cluster )?dump/u.test(dump)) {
    errors.push("postgres/pg_dumpall.sql does not look like pg_dumpall output");
    return false;
  }

  return true;
}

function readBooleanAttestation(values, key, errors) {
  const parsed = parseBoolean(values[key]);

  if (parsed === undefined) {
    errors.push(`${key} must be true or false when set`);
    return false;
  }

  return parsed;
}

function readNow(values, errors) {
  const explicit = cleanValue(values.BACKUP_EVIDENCE_NOW);

  if (explicit !== null) {
    return normalizeIsoDate(explicit, "BACKUP_EVIDENCE_NOW", errors);
  }

  return new Date().toISOString();
}

function normalizeIsoDate(value, key, errors) {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    errors.push(`${key} must be an ISO timestamp when set`);
    return null;
  }

  return new Date(timestamp).toISOString();
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

function backupAudit({
  backups,
  inspected,
  backupDir,
  offsiteUpload,
  offsiteRestore,
  checkedAt,
}) {
  const includesAllComponents = BACKUP_COMPONENTS.every((component) =>
    backups.includes.includes(component),
  );
  const attestations = {
    scheduled: backups.scheduled,
    offHost: backups.offHost,
    encrypted: backups.encrypted,
    restoreCheckPassed: offsiteRestore?.verified === true,
  };
  const checks = [
    check("backup_bundle_verified", inspected !== null, {
      backupDir: backupDir ?? null,
      requiredFileCount: inspected?.requiredFileCount ?? 0,
    }),
    check("checksum_manifest_verified", (inspected?.checksumCount ?? 0) > 0, {
      checksumCount: inspected?.checksumCount ?? 0,
    }),
    check("postgres_dump_verified", inspected?.postgresDumpVerified === true),
    check("offsite_upload_receipt_verified", offsiteUpload?.verified === true),
    check(
      "offsite_restore_receipt_verified",
      offsiteRestore?.verified === true,
    ),
    check(
      "restore_check_passed",
      offsiteRestore?.structuralRestoreCheckPassed === true,
    ),
    check("scheduled", backups.scheduled === true),
    check("off_host", backups.offHost === true),
    check("encrypted", backups.encrypted === true),
    check("components_complete", includesAllComponents, {
      includes: backups.includes,
      requiredComponents: BACKUP_COMPONENTS,
    }),
  ];
  const productionReady = checks.every((item) => item.status === "pass");

  return {
    checkedAt,
    status: productionReady ? "verified" : "incomplete",
    productionReady,
    backupDir: backupDir ?? null,
    backupCreatedAt: backups.lastBackupAt,
    restoreCheckedAt: backups.lastRestoreCheckAt,
    includes: backups.includes,
    attestations,
    offsiteUploadReceipt: offsiteUpload,
    offsiteRestoreReceipt: offsiteRestore,
    checks,
  };
}

function check(name, passed, details = {}) {
  return {
    name,
    status: passed ? "pass" : "fail",
    details,
  };
}

function writeBackupAuditArtifact(outputPath, audit) {
  prepareParent(outputPath);
  writeFileSync(
    outputPath,
    `${JSON.stringify({ backupAudit: audit }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function usage() {
  return `Usage: backup-evidence.mjs [--env-file PATH] [--backup-dir PATH]
                           [--offsite-upload-receipt PATH]
                           [--offsite-restore-receipt PATH]
                           [--audit-output PATH]

Prints a production evidence backups block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced. No secret values
from the private env are printed.

When --backup-dir, BACKUP_DIR, RESTORE_BACKUP_DIR, or
BACKUP_EVIDENCE_BACKUP_DIR points at a backup generated by backup.sh, the helper
verifies the checksum manifest, validates the pg_dumpall marker, reads
MANIFEST.txt created_utc, and infers covered components. A production-ready
result also requires receipts generated by backup-offsite.sh and
restore-offsite-check.sh. Their hashes, remote paths, encryption format,
ciphertext identity, and verification results are cross-checked.

The remaining operator attestation defaults to false unless set:
  BACKUP_EVIDENCE_SCHEDULED

Optional overrides:
  BACKUP_EVIDENCE_AUDIT_OUTPUT
  BACKUP_EVIDENCE_OFFSITE_UPLOAD_RECEIPT
  BACKUP_EVIDENCE_OFFSITE_RESTORE_RECEIPT
  BACKUP_EVIDENCE_NOW

The helper writes a retained local audit artifact to BACKUP_EVIDENCE_AUDIT_OUTPUT,
--audit-output, or $ELIZA_ARTIFACT_ROOT/backup-audit.json by default, then emits
its SHA-256 in backups.backupEvidence.
`;
}
