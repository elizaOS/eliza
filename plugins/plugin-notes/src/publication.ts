/**
 * Publishes complete Notes candidates without replacing an existing state file.
 * Ordinary hosts use hard links; the Android launcher can explicitly supply its
 * packaged no-replace library. A failed native capability never weakens publication.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ElizaError, isElizaError } from "@elizaos/core";

const LIBRARY_NAME = "libeliza_atomic_file.so";

/** Install a complete candidate, or retain the existing destination unchanged. */
export async function publishNotesDocumentIfAbsent(
  source: string,
  destination: string,
): Promise<boolean> {
  const libraryPath = process.env.ELIZA_ATOMIC_FILE_LIBRARY;
  if (libraryPath === undefined) {
    try {
      await fs.link(source, destination);
      return true;
    } catch (error) {
      // error-policy:J3 EEXIST identifies a competing publisher; other failures abort.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        return false;
      }
      throw error;
    }
  }

  if (
    !path.isAbsolute(libraryPath) ||
    libraryPath.includes("\0") ||
    path.basename(libraryPath) !== LIBRARY_NAME ||
    source.includes("\0") ||
    destination.includes("\0")
  ) {
    throw new ElizaError("Notes native publication received an invalid path.", {
      code: "NOTES_NATIVE_PUBLICATION_PATH_INVALID",
      context: { libraryPath, source, destination },
    });
  }
  if (process.platform !== "linux" || !process.versions.bun) {
    throw new ElizaError(
      "Notes native publication requires the packaged Android Bun runtime.",
      {
        code: "NOTES_NATIVE_PUBLICATION_UNAVAILABLE",
        context: { platform: process.platform, libraryPath },
      },
    );
  }

  try {
    const [canonicalLibrary, canonicalExecutable] = await Promise.all([
      fs.realpath(libraryPath),
      fs.realpath(process.execPath),
    ]);
    // The launcher supplies a bundled sibling of the executable, never a search path.
    if (
      path.basename(canonicalLibrary) !== LIBRARY_NAME ||
      path.dirname(canonicalLibrary) !== path.dirname(canonicalExecutable)
    ) {
      throw new ElizaError(
        "Notes publication library is outside the packaged runtime directory.",
        {
          code: "NOTES_NATIVE_PUBLICATION_PATH_INVALID",
          context: { libraryPath, canonicalLibrary, canonicalExecutable },
        },
      );
    }
    const moduleName = "bun:ffi";
    const ffi: typeof import("bun:ffi") = await import(
      /* @vite-ignore */ moduleName
    );
    const library = ffi.dlopen(canonicalLibrary, {
      eliza_atomic_file_publish_noreplace_v1: {
        args: [ffi.FFIType.ptr, ffi.FFIType.ptr],
        returns: ffi.FFIType.i32,
      },
    });
    try {
      const sourceBytes = Buffer.from(`${source}\0`);
      const destinationBytes = Buffer.from(`${destination}\0`);
      const errno = library.symbols.eliza_atomic_file_publish_noreplace_v1(
        ffi.ptr(sourceBytes),
        ffi.ptr(destinationBytes),
      );
      if (errno === 0) return true;
      // This ABI returns Linux errno values on every supported Android architecture.
      if (errno === 17) return false;
      throw new ElizaError("Notes native no-replace publication failed.", {
        code: "NOTES_NATIVE_PUBLICATION_FAILED",
        context: { errno, source, destination, libraryPath },
      });
    } finally {
      library.close();
    }
  } catch (error) {
    // error-policy:J2 retain typed native failures; wrap only untyped loader failures.
    if (isElizaError(error)) throw error;
    throw new ElizaError(
      "Notes could not use its packaged publication capability.",
      {
        code: "NOTES_NATIVE_PUBLICATION_UNAVAILABLE",
        context: { libraryPath, source, destination },
        cause: error,
      },
    );
  }
}
