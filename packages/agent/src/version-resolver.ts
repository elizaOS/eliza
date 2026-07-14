/**
 * Resolves the running Eliza package version from on-disk release metadata.
 * Missing or malformed metadata is fatal because a fabricated version would
 * make package and compatibility checks untrustworthy.
 */
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ElizaError } from "@elizaos/core";

// TypeScript source lives below `src/`, while the published `dist/` contents
// are flattened into the package root. Both layouts must resolve the manifest.
const PACKAGE_JSON_CANDIDATES = [
  "../package.json",
  "../../package.json",
] as const;
const BUILD_INFO_CANDIDATES = [
  "../../build-info.json",
  "../build-info.json",
  "./build-info.json",
] as const;

const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function normalizedVersion(value: unknown, source: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new ElizaError("Eliza version metadata is not a string", {
      code: "VERSION_METADATA_INVALID",
      context: { source, valueType: typeof value },
      severity: "fatal",
    });
  }
  const match = VERSION_PATTERN.exec(value);
  const invalidNumericPrerelease = match?.[1]
    ?.split(".")
    .some(
      (identifier) =>
        /^\d+$/u.test(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith("0"),
    );
  if (value !== value.trim() || !match || invalidNumericPrerelease) {
    throw new ElizaError("Eliza version metadata is not valid SemVer", {
      code: "VERSION_METADATA_INVALID",
      context: { source, version: value },
      severity: "fatal",
    });
  }
  return value;
}

function readVersionFromCandidates(
  moduleUrl: string,
  candidates: readonly string[],
): string | null {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  for (const candidate of candidates) {
    const path = resolve(moduleDirectory, candidate);
    let status: Stats | undefined;
    try {
      status = lstatSync(path, { throwIfNoEntry: false });
    } catch (cause) {
      // error-policy:J2 version identity cannot skip an unreadable candidate.
      throw new ElizaError("Eliza version metadata could not be inspected", {
        code: "VERSION_METADATA_INVALID",
        context: { path },
        cause,
        severity: "fatal",
      });
    }
    if (!status) continue;
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new ElizaError("Eliza version metadata must be a regular file", {
        code: "VERSION_METADATA_INVALID",
        context: { path },
        severity: "fatal",
      });
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      // error-policy:J2 existing release metadata is authoritative; preserve
      // its filesystem or parse failure instead of searching for a fallback.
      throw new ElizaError("Eliza version metadata could not be read", {
        code: "VERSION_METADATA_INVALID",
        context: { path },
        cause,
        severity: "fatal",
      });
    }
    if (typeof metadata !== "object" || metadata === null) {
      throw new ElizaError("Eliza version metadata must be an object", {
        code: "VERSION_METADATA_INVALID",
        context: { path },
        severity: "fatal",
      });
    }
    const version = normalizedVersion(Reflect.get(metadata, "version"), path);
    if (!version) {
      throw new ElizaError("Eliza version metadata has no version", {
        code: "VERSION_METADATA_INVALID",
        context: { path },
        severity: "fatal",
      });
    }
    return version;
  }
  return null;
}

export function resolveElizaVersion(moduleUrl: string): string {
  const version =
    readVersionFromCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES) ??
    readVersionFromCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
  if (version) return version;

  throw new ElizaError(
    "Eliza package version metadata is missing or has no version",
    {
      code: "VERSION_METADATA_MISSING",
      context: { moduleUrl },
      severity: "fatal",
    },
  );
}
