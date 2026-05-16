#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

function usage() {
  console.log(`Usage:
  validate-release-manifest.mjs MANIFEST.json [--artifact-dir DIR]

Validates the Android release manifest shape without requiring devices.
When --artifact-dir is provided, artifact sizes and SHA-256 hashes are checked.`);
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let manifestPath = '';
  let artifactDir = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    }
    if (arg === '--artifact-dir') {
      artifactDir = argv[index + 1] ?? '';
      if (!artifactDir) die('--artifact-dir requires a directory');
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) die(`unknown argument: ${arg}`);
    if (manifestPath) die(`unexpected extra argument: ${arg}`);
    manifestPath = arg;
  }
  if (!manifestPath) die('provide a manifest path');
  return { manifestPath, artifactDir };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`failed to read JSON ${path}: ${error.message}`);
  }
}

function expect(condition, errors, path, message) {
  if (!condition) errors.push(`${path}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateManifest(manifest) {
  const errors = [];
  expect(isObject(manifest), errors, '$', 'manifest must be an object');
  if (!isObject(manifest)) return errors;

  expect(manifest.schemaVersion === 1, errors, '$.schemaVersion', 'must be 1');
  expect(typeof manifest.releaseId === 'string' && manifest.releaseId.length > 0, errors, '$.releaseId', 'must be a non-empty string');
  expect(typeof manifest.generatedAt === 'string' && !Number.isNaN(Date.parse(manifest.generatedAt)), errors, '$.generatedAt', 'must be an ISO date-time string');
  expect(typeof manifest.buildFingerprint === 'string' && manifest.buildFingerprint.length > 0, errors, '$.buildFingerprint', 'must be a non-empty string');

  const validBuildTypes = new Set(['user', 'userdebug', 'eng', 'unknown']);
  if (manifest.buildType !== undefined) {
    expect(validBuildTypes.has(manifest.buildType), errors, '$.buildType', 'must be user, userdebug, eng, or unknown');
  }

  expect(Array.isArray(manifest.supportedDevices) && manifest.supportedDevices.length > 0, errors, '$.supportedDevices', 'must be a non-empty array');
  const deviceCodenames = new Set();
  const tiers = new Set(['lab-validated', 'candidate', 'manual', 'blocked']);
  const slotValues = new Set(['a', 'b', 'none']);
  if (Array.isArray(manifest.supportedDevices)) {
    manifest.supportedDevices.forEach((device, index) => {
      const path = `$.supportedDevices[${index}]`;
      expect(isObject(device), errors, path, 'must be an object');
      if (!isObject(device)) return;
      expect(typeof device.codename === 'string' && /^[a-zA-Z0-9._-]+$/.test(device.codename), errors, `${path}.codename`, 'must be a valid codename');
      if (deviceCodenames.has(device.codename)) errors.push(`${path}.codename: duplicate codename ${device.codename}`);
      deviceCodenames.add(device.codename);
      expect(tiers.has(device.tier), errors, `${path}.tier`, 'must be lab-validated, candidate, manual, or blocked');
      expect(Array.isArray(device.slots) && device.slots.length > 0, errors, `${path}.slots`, 'must be a non-empty array');
      if (Array.isArray(device.slots)) {
        device.slots.forEach((slot) => expect(slotValues.has(slot), errors, `${path}.slots`, `invalid slot ${slot}`));
      }
      expect(typeof device.dynamicPartitions === 'boolean', errors, `${path}.dynamicPartitions`, 'must be boolean');
      expect(typeof device.rollbackSupported === 'boolean', errors, `${path}.rollbackSupported`, 'must be boolean');
    });
  }

  expect(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, errors, '$.artifacts', 'must be a non-empty array');
  const partitions = new Set();
  const fastbootModes = new Set(['bootloader', 'fastbootd']);
  if (Array.isArray(manifest.artifacts)) {
    manifest.artifacts.forEach((artifact, index) => {
      const path = `$.artifacts[${index}]`;
      expect(isObject(artifact), errors, path, 'must be an object');
      if (!isObject(artifact)) return;
      expect(typeof artifact.partition === 'string' && /^[a-zA-Z0-9._-]+$/.test(artifact.partition), errors, `${path}.partition`, 'must be a valid partition name');
      if (partitions.has(artifact.partition)) errors.push(`${path}.partition: duplicate partition ${artifact.partition}`);
      partitions.add(artifact.partition);
      expect(typeof artifact.filename === 'string' && /^[^/\\]+\.img$/.test(artifact.filename), errors, `${path}.filename`, 'must be a local .img filename');
      expect(typeof artifact.sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(artifact.sha256), errors, `${path}.sha256`, 'must be 64 hex characters');
      expect(Number.isInteger(artifact.sizeBytes) && artifact.sizeBytes > 0, errors, `${path}.sizeBytes`, 'must be a positive integer');
      expect(typeof artifact.required === 'boolean', errors, `${path}.required`, 'must be boolean');
      expect(fastbootModes.has(artifact.fastbootMode), errors, `${path}.fastbootMode`, 'must be bootloader or fastbootd');
    });
  }

  expect(isObject(manifest.validation), errors, '$.validation', 'must be an object');
  if (isObject(manifest.validation)) {
    expect(Number.isInteger(manifest.validation.bootTimeoutSeconds) && manifest.validation.bootTimeoutSeconds >= 30, errors, '$.validation.bootTimeoutSeconds', 'must be an integer >= 30');
    expect(isObject(manifest.validation.properties), errors, '$.validation.properties', 'must be an object');
    if (isObject(manifest.validation.properties)) {
      Object.entries(manifest.validation.properties).forEach(([key, value]) => {
        expect(typeof value === 'string', errors, `$.validation.properties.${key}`, 'must be a string');
      });
    }
  }

  return errors;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateArtifacts(manifest, artifactDir) {
  const errors = [];
  if (!artifactDir) return errors;
  for (const artifact of manifest.artifacts ?? []) {
    const path = join(artifactDir, artifact.filename);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      errors.push(`${path}: artifact file not found`);
      continue;
    }
    if (stats.size !== artifact.sizeBytes) {
      errors.push(`${path}: size ${stats.size} does not match manifest ${artifact.sizeBytes}`);
    }
    const hash = sha256File(path);
    if (hash.toLowerCase() !== artifact.sha256.toLowerCase()) {
      errors.push(`${path}: sha256 ${hash} does not match manifest ${artifact.sha256}`);
    }
  }
  return errors;
}

const { manifestPath, artifactDir } = parseArgs(args);
const manifest = readJson(manifestPath);
const errors = [...validateManifest(manifest), ...validateArtifacts(manifest, artifactDir)];
if (errors.length > 0) {
  errors.forEach((error) => console.error(`error: ${error}`));
  process.exit(1);
}

console.log(`manifest ok: ${manifest.releaseId}`);
if (artifactDir) console.log(`artifacts ok: ${artifactDir}`);
