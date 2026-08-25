#!/usr/bin/env bun
/**
 * Creates byte-reproducible WebExtension archives from a built browser tree.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

// DOS ZIP timestamps are local-time encoded and cannot precede 1980. Use the
// second UTC day so negative-offset hosts remain within the representable range.
const ZIP_EPOCH = new Date("1980-01-02T00:00:00.000Z");

async function collectFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolute)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Refusing to package non-regular extension path: ${absolute}`,
      );
    }
    if (entry.name.endsWith(".map")) {
      continue;
    }
    files.push({
      absolute,
      relative: path.relative(root, absolute).split(path.sep).join("/"),
      mode: (await fs.stat(absolute)).mode & 0o777,
    });
  }
  return files;
}

export async function createDeterministicDirectoryArchive({
  sourceDir,
  outputPath,
  rootName,
}) {
  const files = await collectFiles(sourceDir);
  const input = {};
  for (const file of files) {
    const archivePath = rootName
      ? `${rootName.replace(/\/$/, "")}/${file.relative}`
      : file.relative;
    input[archivePath] = [
      new Uint8Array(await fs.readFile(file.absolute)),
      {
        attrs: file.mode << 16,
        mtime: ZIP_EPOCH,
        os: 3,
      },
    ];
  }
  const archive = zipSync(input, { level: 9 });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, archive);
  return {
    path: outputPath,
    bytes: archive.byteLength,
    sha256: createHash("sha256").update(archive).digest("hex"),
    files: files.map((file) => file.relative),
  };
}

export async function createDeterministicWebExtensionArchive({
  sourceDir,
  outputPath,
}) {
  const manifestPath = path.join(sourceDir, "manifest.json");
  await fs.access(manifestPath);
  return createDeterministicDirectoryArchive({ sourceDir, outputPath });
}
