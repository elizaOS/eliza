/**
 * Creates a deterministic inventory of the Cloudflare Pages bundle and verifies
 * that every public file is served byte-for-byte after a production deploy.
 * Pages-only control files are excluded because Cloudflare consumes rather than
 * serves them; the manifest itself is verified separately as the release gate.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const MANIFEST_FILENAME = "deployment-manifest.json";

const SCHEMA_VERSION = 1;
const MAXIMUM_DIRECTORIES = 128;
const MAXIMUM_FILES = 256;
const MAXIMUM_FILE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 128 * 1024 * 1024;
const MAXIMUM_PATH_BYTES = 1_024;
const MAXIMUM_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RETRIES = 12;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 5 * 60_000;
const CANONICAL_ORIGIN = "https://eliza.army";
const RESERVED_PATHS = new Set(["_headers", "_redirects", MANIFEST_FILENAME]);
const digestPattern = /^[0-9a-f]{64}$/u;
const verificationTokenPattern = /^[A-Za-z0-9._-]{1,128}$/u;

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, expected, context) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(sortedKeys(value)) !== JSON.stringify([...expected].sort())
  ) {
    throw new TypeError(`${context} has an invalid schema`);
  }
}

function canonicalPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    containsControlCharacter(path) ||
    path.normalize("NFC") !== path ||
    Buffer.byteLength(path, "utf8") > MAXIMUM_PATH_BYTES
  ) {
    throw new TypeError(
      `bundle path is not canonical: ${JSON.stringify(path)}`,
    );
  }
  const parts = path.split("/");
  if (
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError(
      `bundle path is not canonical: ${JSON.stringify(path)}`,
    );
  }
  return path;
}

function collisionKey(path) {
  return path.normalize("NFC").toLowerCase();
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

async function inventory(root) {
  const rootStatus = await lstat(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new TypeError("bundle root must be a real directory");
  }

  const files = [];
  const seenPaths = new Set();
  let directoryCount = 0;
  let totalBytes = 0;

  async function visit(directory, prefix) {
    directoryCount += 1;
    if (directoryCount > MAXIMUM_DIRECTORIES) {
      throw new RangeError(
        `bundle exceeds the ${MAXIMUM_DIRECTORIES}-directory bound`,
      );
    }

    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.from(left.name).compare(Buffer.from(right.name)),
    );
    for (const entry of entries) {
      const relativePath = canonicalPath(
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`,
      );
      const absolutePath = join(directory, entry.name);
      const status = await lstat(absolutePath);
      if (status.isSymbolicLink()) {
        throw new TypeError(
          `bundle entries must not be symbolic links: ${JSON.stringify(relativePath)}`,
        );
      }
      if (status.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!status.isFile()) {
        throw new TypeError(
          `bundle entries must be regular files: ${JSON.stringify(relativePath)}`,
        );
      }
      if (RESERVED_PATHS.has(relativePath)) {
        continue;
      }
      if (files.length >= MAXIMUM_FILES) {
        throw new RangeError(`bundle exceeds the ${MAXIMUM_FILES}-file bound`);
      }
      if (status.size > MAXIMUM_FILE_BYTES) {
        throw new RangeError(
          `bundle file exceeds the ${MAXIMUM_FILE_BYTES}-byte bound: ${JSON.stringify(relativePath)}`,
        );
      }
      totalBytes += status.size;
      if (totalBytes > MAXIMUM_TOTAL_BYTES) {
        throw new RangeError(
          `bundle exceeds the ${MAXIMUM_TOTAL_BYTES}-byte aggregate bound`,
        );
      }
      const pathKey = collisionKey(relativePath);
      if (seenPaths.has(pathKey)) {
        throw new TypeError(
          `bundle contains a case-insensitive path collision: ${JSON.stringify(relativePath)}`,
        );
      }
      seenPaths.add(pathKey);

      const contents = await readFile(absolutePath);
      if (contents.byteLength !== status.size) {
        throw new Error(
          `bundle file changed while it was inventoried: ${JSON.stringify(relativePath)}`,
        );
      }
      files.push({
        path: relativePath,
        bytes: contents.byteLength,
        sha256: digest(contents),
      });
    }
  }

  await visit(root, "");
  files.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  return files;
}

function validateManifestShape(manifest) {
  assertExactKeys(manifest, ["files", "schemaVersion"], "deployment manifest");
  if (
    manifest.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(manifest.files)
  ) {
    throw new TypeError(
      "deployment manifest has an unsupported schema version",
    );
  }
  if (manifest.files.length === 0 || manifest.files.length > MAXIMUM_FILES) {
    throw new RangeError(
      "deployment manifest file count is outside its bounds",
    );
  }

  const paths = new Set();
  let previousPath;
  let totalBytes = 0;
  for (const [index, record] of manifest.files.entries()) {
    assertExactKeys(
      record,
      ["bytes", "path", "sha256"],
      `manifest file ${index}`,
    );
    const path = canonicalPath(record.path);
    if (RESERVED_PATHS.has(path)) {
      throw new TypeError(
        `deployment manifest contains a reserved path: ${path}`,
      );
    }
    if (
      previousPath !== undefined &&
      Buffer.from(previousPath).compare(Buffer.from(path)) >= 0
    ) {
      throw new TypeError(
        "deployment manifest paths must be uniquely byte-sorted",
      );
    }
    previousPath = path;
    const pathKey = collisionKey(path);
    if (paths.has(pathKey)) {
      throw new TypeError(
        `deployment manifest contains a path collision: ${path}`,
      );
    }
    paths.add(pathKey);
    if (
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      record.bytes > MAXIMUM_FILE_BYTES
    ) {
      throw new RangeError(
        `deployment manifest has an invalid byte count: ${path}`,
      );
    }
    if (
      typeof record.sha256 !== "string" ||
      !digestPattern.test(record.sha256)
    ) {
      throw new TypeError(`deployment manifest has an invalid digest: ${path}`);
    }
    totalBytes += record.bytes;
    if (totalBytes > MAXIMUM_TOTAL_BYTES) {
      throw new RangeError(
        "deployment manifest aggregate bytes exceed the bound",
      );
    }
  }
  for (const requiredPath of ["index.html", "skill-manifest.json"]) {
    if (!paths.has(collisionKey(requiredPath))) {
      throw new TypeError(`deployment manifest is missing ${requiredPath}`);
    }
  }
}

async function loadLocalManifest(root) {
  const manifestPath = join(root, MANIFEST_FILENAME);
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.byteLength > MAXIMUM_MANIFEST_BYTES) {
    throw new RangeError(
      `deployment manifest exceeds the ${MAXIMUM_MANIFEST_BYTES}-byte bound`,
    );
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifestShape(manifest);
  const canonicalBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (!canonicalBytes.equals(manifestBytes)) {
    throw new TypeError("deployment manifest is not canonical JSON");
  }
  const currentFiles = await inventory(root);
  if (JSON.stringify(currentFiles) !== JSON.stringify(manifest.files)) {
    throw new Error(
      "deployment manifest does not match the local Pages bundle",
    );
  }
  return { manifest, manifestBytes };
}

export async function createDistManifest(distRoot) {
  const root = resolve(distRoot);
  const files = await inventory(root);
  const manifest = { schemaVersion: SCHEMA_VERSION, files };
  validateManifestShape(manifest);
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAXIMUM_MANIFEST_BYTES) {
    throw new RangeError(
      `deployment manifest exceeds the ${MAXIMUM_MANIFEST_BYTES}-byte bound`,
    );
  }
  await writeFile(join(root, MANIFEST_FILENAME), contents, {
    encoding: "utf8",
    mode: 0o644,
  });
  return manifest;
}

function remoteUrl(origin, path, verificationToken, attempt) {
  const encodedPath = canonicalPath(path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = new URL(`/${encodedPath}`, origin);
  url.searchParams.set("verify", `${verificationToken}-${attempt}`);
  return url;
}

async function responseDigest(response, maximumBytes) {
  if (response.body === null) {
    throw new Error("published file response omitted its body");
  }
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel("published file exceeded its expected byte count");
      throw new RangeError("published file exceeded its expected byte count");
    }
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function fetchExact(record, options) {
  let lastError;
  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    const remainingMs = options.deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `deployment verification reached its total time bound while checking ${record.path}`,
        { cause: lastError },
      );
    }
    const url = remoteUrl(
      options.origin,
      record.path,
      options.verificationToken,
      attempt,
    );
    try {
      const response = await options.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: {
          Accept: "*/*",
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(options.requestTimeoutMs, remainingMs)),
        ),
      });
      if (response.status !== 200) {
        throw new Error(`published file returned HTTP ${response.status}`);
      }
      const received = await responseDigest(response, record.bytes);
      if (
        received.bytes !== record.bytes ||
        received.sha256 !== record.sha256
      ) {
        throw new Error("published bytes did not match the verified bundle");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) {
        options.report(
          `verification attempt ${attempt}/${options.retries} failed for ${record.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        const delayMs = Math.min(
          options.retryDelayMs,
          Math.max(0, options.deadline - Date.now()),
        );
        if (delayMs > 0) {
          await options.delayImpl(delayMs);
        }
      }
    }
  }
  throw new Error(
    `published ${record.path} did not match after ${options.retries} attempts`,
    { cause: lastError },
  );
}

export async function verifyPublishedBundle(
  distRoot,
  origin,
  verificationToken,
  overrides = {},
) {
  if (!verificationTokenPattern.test(verificationToken)) {
    throw new TypeError("verification token must be 1-128 URL-safe characters");
  }
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.origin !== origin ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search.length > 0 ||
    parsedOrigin.hash.length > 0
  ) {
    throw new TypeError(
      "verification origin must contain only scheme and authority",
    );
  }
  const retries = overrides.retries ?? DEFAULT_RETRIES;
  const concurrency = overrides.concurrency ?? DEFAULT_CONCURRENCY;
  const retryDelayMs = overrides.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const requestTimeoutMs =
    overrides.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const totalTimeoutMs = overrides.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(retries) ||
    retries < 1 ||
    retries > DEFAULT_RETRIES ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > DEFAULT_CONCURRENCY ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 0 ||
    retryDelayMs > DEFAULT_RETRY_DELAY_MS ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > DEFAULT_REQUEST_TIMEOUT_MS ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs < 1 ||
    totalTimeoutMs > DEFAULT_TOTAL_TIMEOUT_MS
  ) {
    throw new RangeError("deployment verification options exceed their bounds");
  }

  const root = resolve(distRoot);
  const { manifest, manifestBytes } = await loadLocalManifest(root);
  const options = {
    concurrency,
    deadline: Date.now() + totalTimeoutMs,
    delayImpl: overrides.delayImpl ?? delay,
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    origin,
    report:
      overrides.report ??
      ((message) => process.stdout.write(`::warning::${message}\n`)),
    requestTimeoutMs,
    retries,
    retryDelayMs,
    verificationToken,
  };

  await fetchExact(
    {
      path: MANIFEST_FILENAME,
      bytes: manifestBytes.byteLength,
      sha256: digest(manifestBytes),
    },
    options,
  );

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < manifest.files.length) {
      const index = nextIndex;
      nextIndex += 1;
      await fetchExact(manifest.files[index], options);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, manifest.files.length) }, () =>
      worker(),
    ),
  );
  return manifest.files.length;
}

async function main(arguments_) {
  const [command, distRoot, origin, verificationToken, ...extra] = arguments_;
  if (command === "create" && distRoot !== undefined && origin === undefined) {
    const manifest = await createDistManifest(distRoot);
    process.stdout.write(
      `[DistManifest] Wrote ${manifest.files.length} public files to ${join(resolve(distRoot), MANIFEST_FILENAME)}.\n`,
    );
    return;
  }
  if (
    command === "verify" &&
    distRoot !== undefined &&
    origin === CANONICAL_ORIGIN &&
    verificationToken !== undefined &&
    extra.length === 0
  ) {
    const count = await verifyPublishedBundle(
      distRoot,
      origin,
      verificationToken,
    );
    process.stdout.write(
      `[DistManifest] Verified ${count} public files and the manifest at ${origin}.\n`,
    );
    return;
  }
  throw new TypeError(
    `Usage: ${basename(process.argv[1])} create <dist> | verify <dist> ${CANONICAL_ORIGIN} <token>`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `[DistManifest] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
