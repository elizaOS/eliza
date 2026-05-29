#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function usage() {
  console.error(
    "Usage: scripts/validate-model-catalog.mjs --catalog model-catalog.json [--root DIR]",
  );
  process.exit(64);
}

const args = process.argv.slice(2);
let catalogPath = "";
let artifactRoot = "";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--catalog") {
    catalogPath = args[index + 1] ?? "";
    index += 1;
  } else if (arg.startsWith("--catalog=")) {
    catalogPath = arg.slice("--catalog=".length);
  } else if (arg === "--root") {
    artifactRoot = args[index + 1] ?? "";
    index += 1;
  } else if (arg.startsWith("--root=")) {
    artifactRoot = arg.slice("--root=".length);
  } else if (!arg.startsWith("--") && !catalogPath) {
    catalogPath = arg;
  }
}

if (!catalogPath) usage();

catalogPath = path.resolve(catalogPath);
artifactRoot = path.resolve(artifactRoot || path.dirname(catalogPath));

const errors = [];
const sha256Re = /^[a-fA-F0-9]{64}$/;

function fail(message) {
  errors.push(message);
}

function safeRelative(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} must be a non-empty relative path`);
    return null;
  }
  if (
    value.startsWith("/") ||
    value.includes("\0") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${field} is unsafe: ${value}`);
    return null;
  }
  return value;
}

function resolveUnder(root, relative, field) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
    fail(`${field} escapes artifact root: ${relative}`);
    return null;
  }
  return resolved;
}

function fileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

let catalog;
try {
  catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
} catch (error) {
  fail(`${catalogPath}: invalid JSON: ${error.message}`);
}

if (catalog) {
  if (catalog.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (catalog.kind !== "elizaos.modelCatalog") {
    fail("kind must be elizaos.modelCatalog");
  }
  if (typeof catalog.catalogVersion !== "string" || !catalog.catalogVersion) {
    fail("catalogVersion is required");
  }
  if (!Array.isArray(catalog.models)) {
    fail("models must be an array");
  } else {
    const modelIds = new Set();
    for (const [modelIndex, model] of catalog.models.entries()) {
      const modelPrefix = `models[${modelIndex}]`;
      if (
        typeof model.id !== "string" ||
        !/^[A-Za-z0-9._:-]+$/.test(model.id)
      ) {
        fail(`${modelPrefix}.id is required and must be path-safe`);
      } else if (modelIds.has(model.id)) {
        fail(`${modelPrefix}.id is duplicated: ${model.id}`);
      } else {
        modelIds.add(model.id);
      }
      if (!Array.isArray(model.modalities) || model.modalities.length === 0) {
        fail(`${modelPrefix}.modalities must be a non-empty array`);
      }
      if (!Array.isArray(model.artifacts) || model.artifacts.length === 0) {
        fail(`${modelPrefix}.artifacts must be a non-empty array`);
        continue;
      }
      for (const [artifactIndex, artifact] of model.artifacts.entries()) {
        const artifactPrefix = `${modelPrefix}.artifacts[${artifactIndex}]`;
        const relative = safeRelative(artifact.path, `${artifactPrefix}.path`);
        if (!sha256Re.test(artifact.sha256 ?? "")) {
          fail(`${artifactPrefix}.sha256 must be a SHA-256 hex digest`);
        }
        if (!relative) continue;
        const artifactPath = resolveUnder(
          artifactRoot,
          relative,
          `${artifactPrefix}.path`,
        );
        if (!artifactPath) continue;
        if (!fs.existsSync(artifactPath)) {
          fail(`${artifactPrefix}.path missing: ${artifactPath}`);
          continue;
        }
        if (!fs.statSync(artifactPath).isFile()) {
          fail(`${artifactPrefix}.path is not a file: ${artifactPath}`);
          continue;
        }
        const actual = fileSha256(artifactPath);
        if (actual.toLowerCase() !== artifact.sha256.toLowerCase()) {
          fail(`${artifactPrefix}.sha256 mismatch for ${artifact.path}`);
        }
      }
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}

console.log(`model catalog ok: ${catalogPath}`);
