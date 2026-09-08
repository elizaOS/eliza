/** Reads and validates Android build archives without trusting entry paths, metadata, or decompressed sizes. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";
import { resolveAndroidArtifactKind } from "../../lib/android-cloud-artifact-audit.mjs";
import { ElizaError } from "../../lib/eliza-error.mjs";
import { mobileBuildError } from "../build-error.mjs";

export const MAX_ANDROID_ARTIFACT_BYTES = 512 * 1024 * 1024;

export const MAX_ANDROID_ARCHIVE_ENTRIES = 100_000;

export const MAX_ANDROID_EXTRACTED_ENTRY_BYTES = 256 * 1024 * 1024;

export const MAX_ANDROID_EXTRACTED_TOTAL_BYTES = 512 * 1024 * 1024;

export function assertSafeAndroidArchiveEntry(entry, label) {
  if (typeof entry !== "string" || entry === "") {
    throw mobileBuildError(
      `[mobile-build] Refusing empty archive path for ${label}.`,
      {
        code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
        context: { entry, label },
      },
    );
  }
  const pathWithoutDirectorySuffix = entry.endsWith("/")
    ? entry.slice(0, -1)
    : entry;
  const segments = pathWithoutDirectorySuffix.split("/");
  if (
    pathWithoutDirectorySuffix === "" ||
    entry.includes("\\") ||
    entry.includes("\0") ||
    path.posix.isAbsolute(entry) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    path.posix.normalize(pathWithoutDirectorySuffix) !==
      pathWithoutDirectorySuffix
  ) {
    throw mobileBuildError(
      `[mobile-build] Refusing unsafe archive path for ${label}: ${entry}`,
      {
        code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
        context: { entry, label },
      },
    );
  }
}

export function snapshotAndroidArtifact(
  artifact,
  {
    closeSync = fs.closeSync,
    fstatSync = fs.fstatSync,
    maxArtifactBytes = MAX_ANDROID_ARTIFACT_BYTES,
    openSync = fs.openSync,
    readSync = fs.readSync,
  } = {},
) {
  let descriptor;
  let stats;
  let bytes;
  try {
    descriptor = openSync(artifact, "r");
    stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error("artifact path is not a regular file");
    }
    if (stats.size > maxArtifactBytes) {
      throw mobileBuildError(
        `[mobile-build] Android artifact exceeds the ${maxArtifactBytes}-byte audit limit: ${artifact}`,
        {
          code: "ANDROID_ARTIFACT_TOO_LARGE",
          context: {
            artifact,
            maxBytes: maxArtifactBytes,
            sizeBytes: stats.size,
          },
        },
      );
    }
    bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const bytesRead = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extraByte = Buffer.allocUnsafe(1);
    const extraBytesRead = readSync(descriptor, extraByte, 0, 1, offset);
    const finalStats = fstatSync(descriptor);
    if (
      offset !== bytes.byteLength ||
      extraBytesRead !== 0 ||
      finalStats.size !== stats.size
    ) {
      throw mobileBuildError(
        `[mobile-build] Android artifact changed while it was being snapshotted: ${artifact}`,
        {
          code: "ANDROID_ARTIFACT_CHANGED_DURING_AUDIT",
          context: {
            artifact,
            bytesRead: offset + extraBytesRead,
            expectedBytes: stats.size,
            finalSizeBytes: finalStats.size,
          },
        },
      );
    }
  } catch (cause) {
    // error-policy:J2 preserve the artifact path around snapshot I/O failures
    if (
      cause?.code === "ANDROID_ARTIFACT_TOO_LARGE" ||
      cause?.code === "ANDROID_ARTIFACT_CHANGED_DURING_AUDIT"
    ) {
      throw cause;
    }
    throw mobileBuildError(
      `[mobile-build] Could not snapshot Android artifact ${artifact}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        code: "ANDROID_ARTIFACT_SNAPSHOT_FAILED",
        context: { artifact },
      },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return {
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

export function assertAndroidArtifactSnapshotUnchanged(
  artifact,
  before,
  after,
) {
  if (before.sha256 !== after.sha256 || before.sizeBytes !== after.sizeBytes) {
    throw mobileBuildError(
      `[mobile-build] Android artifact changed during audit; refusing evidence for unstable bytes: ${artifact}`,
      {
        code: "ANDROID_ARTIFACT_CHANGED_DURING_AUDIT",
        context: {
          artifact,
          after: {
            sha256: after.sha256,
            sizeBytes: after.sizeBytes,
          },
          before: {
            sha256: before.sha256,
            sizeBytes: before.sizeBytes,
          },
        },
      },
    );
  }
}

/**
 * Parses APK/AAB metadata from a bounded immutable byte snapshot.
 *
 * adm-zip handles ZIP64 central-directory records, while extraction remains
 * below under an explicit output bound. Reading each compressed slice forces
 * local-header parsing without expanding attacker-controlled payload bytes.
 */
export function readAndroidArtifactArchiveMetadata(
  artifact,
  bytes,
  { maxEntries = MAX_ANDROID_ARCHIVE_ENTRIES } = {},
) {
  const decoder = {
    efs: true,
    decode: (value) => new TextDecoder("utf-8", { fatal: true }).decode(value),
    encode: (value) => Buffer.from(value, "utf8"),
  };
  try {
    const archive = new AdmZip(bytes, {
      decoder,
      noSort: true,
    });
    const archiveEntries = archive.getEntries();
    if (archiveEntries.length === 0) {
      throw mobileBuildError(
        `[mobile-build] Android artifact archive has no entries: ${artifact}`,
        {
          code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
          context: { artifact },
        },
      );
    }
    if (archiveEntries.length > maxEntries) {
      throw mobileBuildError(
        `[mobile-build] Android artifact exceeds the ${maxEntries}-entry audit limit: ${artifact}`,
        {
          code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
          context: {
            artifact,
            entries: archiveEntries.length,
            maxEntries,
          },
        },
      );
    }

    const seen = new Set();
    return archiveEntries.map((archiveEntry) => {
      const entry = archiveEntry.entryName;
      assertSafeAndroidArchiveEntry(entry, "artifact entry discovery");
      if (seen.has(entry)) {
        throw mobileBuildError(
          `[mobile-build] Android artifact contains duplicate archive entry: ${entry}`,
          {
            code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
            context: { artifact, entry },
          },
        );
      }
      seen.add(entry);

      const header = archiveEntry.header;
      const numericFields = {
        compressedSize: header.compressedSize,
        crc32: header.crc,
        localHeaderOffset: header.offset,
        size: header.size,
      };
      for (const [field, value] of Object.entries(numericFields)) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw mobileBuildError(
            `[mobile-build] Android artifact has an invalid ${field} for ${entry}.`,
            {
              code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
              context: { artifact, entry, field, value },
            },
          );
        }
      }
      if (header.diskNumStart !== 0) {
        throw mobileBuildError(
          `[mobile-build] Multi-disk Android artifacts are not supported: ${entry}`,
          {
            code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
            context: {
              artifact,
              diskNumber: header.diskNumStart,
              entry,
            },
          },
        );
      }
      if (header.encrypted) {
        throw mobileBuildError(
          `[mobile-build] Encrypted Android artifact entries cannot be audited: ${entry}`,
          {
            code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
            context: { artifact, entry },
          },
        );
      }

      const compressedBytes = archiveEntry.getCompressedData();
      const localHeader = header.localHeader;
      if (compressedBytes.byteLength !== header.compressedSize) {
        throw mobileBuildError(
          `[mobile-build] Android artifact entry ${entry} has inconsistent compressed size metadata.`,
          {
            code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
            context: {
              actualCompressedSize: compressedBytes.byteLength,
              artifact,
              entry,
              expectedCompressedSize: header.compressedSize,
            },
          },
        );
      }
      if (
        localHeader.flags !== header.flags ||
        localHeader.method !== header.method
      ) {
        throw mobileBuildError(
          `[mobile-build] Android artifact entry ${entry} has inconsistent local and central headers.`,
          {
            code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
            context: {
              artifact,
              centralFlags: header.flags,
              centralMethod: header.method,
              entry,
              localFlags: localHeader.flags,
              localMethod: localHeader.method,
            },
          },
        );
      }

      const localNameStart = header.offset + 30;
      const localNameEnd = localNameStart + localHeader.fnameLen;
      if (
        localNameStart < 30 ||
        localNameEnd > bytes.byteLength ||
        !bytes
          .subarray(localNameStart, localNameEnd)
          .equals(Buffer.from(archiveEntry.rawEntryName))
      ) {
        throw mobileBuildError(
          `[mobile-build] Android artifact entry ${entry} has mismatched local filename metadata.`,
          {
            code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
            context: { artifact, entry },
          },
        );
      }

      if (!header.flags_desc) {
        const localSizeMatches =
          localHeader.size === header.size || localHeader.size === 0xffffffff;
        const localCompressedSizeMatches =
          localHeader.compressedSize === header.compressedSize ||
          localHeader.compressedSize === 0xffffffff;
        if (
          localHeader.crc !== header.crc ||
          !localSizeMatches ||
          !localCompressedSizeMatches
        ) {
          throw mobileBuildError(
            `[mobile-build] Android artifact entry ${entry} has inconsistent local integrity metadata.`,
            {
              code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
              context: {
                artifact,
                entry,
                expectedCompressedSize: header.compressedSize,
                expectedCrc32: header.crc,
                expectedSize: header.size,
                localCompressedSize: localHeader.compressedSize,
                localCrc32: localHeader.crc,
                localSize: localHeader.size,
              },
            },
          );
        }
      }

      return {
        compressedBytes,
        compressedSize: header.compressedSize,
        crc32: header.crc,
        entry,
        method: header.method,
        size: header.size,
      };
    });
  } catch (cause) {
    // error-policy:J2 preserve artifact identity around archive parser failures
    if (
      cause instanceof ElizaError &&
      cause.code.startsWith("ANDROID_ARTIFACT_")
    ) {
      throw cause;
    }
    throw mobileBuildError(
      `[mobile-build] Could not inspect Android artifact archive ${artifact}: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
        context: { artifact },
      },
    );
  }
}

export function listAndroidArtifactEntries(
  artifact,
  _javaHome,
  { artifactBytes, maxEntries = MAX_ANDROID_ARCHIVE_ENTRIES } = {},
) {
  const bytes =
    artifactBytes === undefined
      ? snapshotAndroidArtifact(artifact).bytes
      : Buffer.from(artifactBytes);
  return readAndroidArtifactArchiveMetadata(artifact, bytes, {
    maxEntries,
  }).map(({ entry }) => entry);
}

export function readAndroidArtifactEntryBuffers(
  artifact,
  entries,
  _javaHome,
  {
    artifactBytes,
    label = "artifact policy",
    maxEntryBytes = MAX_ANDROID_EXTRACTED_ENTRY_BYTES,
    maxTotalBytes = MAX_ANDROID_EXTRACTED_TOTAL_BYTES,
  } = {},
) {
  for (const entry of entries) {
    assertSafeAndroidArchiveEntry(entry, label);
  }
  const bytes =
    artifactBytes === undefined
      ? snapshotAndroidArtifact(artifact).bytes
      : Buffer.from(artifactBytes);
  const metadata = readAndroidArtifactArchiveMetadata(artifact, bytes);
  const metadataByEntry = new Map(
    metadata.map((entryMetadata) => [entryMetadata.entry, entryMetadata]),
  );
  let expectedCompressedTotalBytes = 0;
  let expectedTotalBytes = 0;
  const selectedMetadata = entries.map((entry) => {
    const entryMetadata = metadataByEntry.get(entry);
    if (!entryMetadata) {
      throw mobileBuildError(
        `[mobile-build] Android artifact is missing requested ${label} entry: ${entry}`,
        {
          code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
          context: { artifact, entry, label },
        },
      );
    }
    if (
      entryMetadata.compressedSize > maxEntryBytes ||
      entryMetadata.size > maxEntryBytes
    ) {
      throw mobileBuildError(
        `[mobile-build] ${label} entry exceeds the ${maxEntryBytes}-byte audit limit: ${entry}`,
        {
          code: "ANDROID_ARTIFACT_ENTRY_TOO_LARGE",
          context: {
            artifact,
            compressedSizeBytes: entryMetadata.compressedSize,
            entry,
            maxBytes: maxEntryBytes,
            sizeBytes: entryMetadata.size,
          },
        },
      );
    }
    expectedCompressedTotalBytes += entryMetadata.compressedSize;
    expectedTotalBytes += entryMetadata.size;
    if (
      expectedCompressedTotalBytes > maxTotalBytes ||
      expectedTotalBytes > maxTotalBytes
    ) {
      throw mobileBuildError(
        `[mobile-build] ${label} entries exceed the ${maxTotalBytes}-byte total audit limit.`,
        {
          code: "ANDROID_ARTIFACT_ENTRY_TOO_LARGE",
          context: {
            artifact,
            compressedTotalBytes: expectedCompressedTotalBytes,
            maxTotalBytes,
            totalBytes: expectedTotalBytes,
          },
        },
      );
    }
    return entryMetadata;
  });

  let actualTotalBytes = 0;
  return selectedMetadata.map((entryMetadata) => {
    let bytesForEntry;
    try {
      if (entryMetadata.method === 0) {
        bytesForEntry = Buffer.from(entryMetadata.compressedBytes);
      } else if (entryMetadata.method === 8) {
        bytesForEntry = inflateRawSync(entryMetadata.compressedBytes, {
          maxOutputLength: Math.max(1, entryMetadata.size),
        });
      } else {
        throw new Error(
          `unsupported ZIP compression method ${entryMetadata.method}`,
        );
      }
    } catch (cause) {
      // error-policy:J2 preserve entry identity around payload decoder failures
      throw mobileBuildError(
        `[mobile-build] Could not decode ${label} entry ${entryMetadata.entry}: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
          code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
          context: {
            artifact,
            entry: entryMetadata.entry,
            label,
            method: entryMetadata.method,
          },
        },
      );
    }

    actualTotalBytes += bytesForEntry.byteLength;
    if (
      bytesForEntry.byteLength > maxEntryBytes ||
      actualTotalBytes > maxTotalBytes
    ) {
      throw mobileBuildError(
        `[mobile-build] Extracted ${label} payload exceeds the bounded audit size.`,
        {
          code: "ANDROID_ARTIFACT_ENTRY_TOO_LARGE",
          context: {
            artifact,
            entry: entryMetadata.entry,
            entryBytes: bytesForEntry.byteLength,
            totalBytes: actualTotalBytes,
          },
        },
      );
    }
    if (bytesForEntry.byteLength !== entryMetadata.size) {
      throw mobileBuildError(
        `[mobile-build] ${label} entry ${entryMetadata.entry} expanded to ${bytesForEntry.byteLength} bytes; the archive declares ${entryMetadata.size}.`,
        {
          code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
          context: {
            actualSizeBytes: bytesForEntry.byteLength,
            artifact,
            entry: entryMetadata.entry,
            expectedSizeBytes: entryMetadata.size,
            label,
          },
        },
      );
    }
    const actualCrc32 = crc32(bytesForEntry) >>> 0;
    if (actualCrc32 !== entryMetadata.crc32) {
      throw mobileBuildError(
        `[mobile-build] ${label} entry ${entryMetadata.entry} failed CRC32 verification.`,
        {
          code: "ANDROID_ARTIFACT_ARCHIVE_INVALID",
          context: {
            actualCrc32,
            artifact,
            entry: entryMetadata.entry,
            expectedCrc32: entryMetadata.crc32,
            label,
          },
        },
      );
    }
    return bytesForEntry;
  });
}

/**
 * Require the Background Runner Java class that its native JS engine resolves
 * through JNI. R8 cannot infer this edge from Java bytecode, so a missing class
 * is a release-startup crash rather than a safely unused implementation detail.
 */
export function assertAndroidArtifactRetainsBackgroundRunnerJniBridge(
  artifact,
  entries,
  javaHome,
  { label = "Android" } = {},
  { readEntryBuffers = readAndroidArtifactEntryBuffers } = {},
) {
  const dexEntries = entries.filter((entry) =>
    /(^|\/)classes\d*\.dex$/.test(entry),
  );
  if (dexEntries.length === 0) {
    throw mobileBuildError(
      `[mobile-build] Android artifact has no classes*.dex entries: ${artifact}`,
      {
        code: "ANDROID_ARTIFACT_DEX_MISSING",
        context: { artifact, label },
      },
    );
  }

  const marker = "io/ionic/android_js_engine/NativeWebAPI";
  const dexBuffers = readEntryBuffers(artifact, dexEntries, javaHome, {
    label: "Background Runner JNI DEX audit",
  });
  if (dexBuffers.some((dex) => dex.includes(Buffer.from(marker, "utf8")))) {
    return;
  }

  throw mobileBuildError(
    `[mobile-build] ${label} artifact DEX is missing the Background Runner JNI class ${marker.replaceAll("/", ".")}.`,
    {
      code: "ANDROID_BACKGROUND_RUNNER_JNI_CLASS_MISSING",
      context: { artifact, label, marker },
    },
  );
}

/**
 * Positive assertion that an installable APK actually ships the web renderer
 * (and, for local builds, the on-device agent). Without this, a sync that
 * lands the web payload in the wrong tree produces a web-less APK that boots
 * to net::ERR_CONNECTION_REFUSED — the failure this guard exists to prevent
 * (elizaOS/eliza#8387). `assets/public/index.html` is the WebView entrypoint,
 * `assets/capacitor.config.json` is the Capacitor runtime config, and
 * `assets/agent/` is the staged local-agent payload (only present on
 * local/sideload builds; cloud thin clients deliberately strip it).
 */
export function assertAndroidArtifactShipsWebPayload(
  artifact,
  entries,
  { requireAgent = false, label = "android" } = {},
) {
  const assetRoot =
    resolveAndroidArtifactKind(artifact) === "aab" ? "base/assets/" : "assets/";
  const hasAssetFile = (suffix) => entries.includes(`${assetRoot}${suffix}`);
  const hasAssetDir = (prefix) =>
    entries.some((entry) => entry.startsWith(`${assetRoot}${prefix}`));
  const required = ["public/index.html", "capacitor.config.json"];
  const missing = required.filter((suffix) => !hasAssetFile(suffix));
  if (requireAgent && !hasAssetDir("agent/")) missing.push("assets/agent/");
  if (missing.length > 0) {
    throw mobileBuildError(
      `[mobile-build] ${label} artifact is missing required packaged payload — ` +
        `it would ship a web-less app that fails with ERR_CONNECTION_REFUSED:\n` +
        missing.map((entry) => `  - ${entry}`).join("\n") +
        `\n  artifact: ${artifact}`,
      {
        code: "ANDROID_ARTIFACT_WEB_PAYLOAD_MISSING",
        context: {
          artifact,
          artifactKind: resolveAndroidArtifactKind(artifact),
          label,
          missing,
        },
      },
    );
  }
}
