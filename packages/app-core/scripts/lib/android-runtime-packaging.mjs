/** Preserves provenance-bound native runtime bytes through Android release packaging. */

export const ANDROID_RUNTIME_KEEP_DEBUG_SYMBOLS = Object.freeze([
  "**/libeliza_*.so",
  "**/libsigsys-handler.so",
]);

export const ANDROID_RUNTIME_PACKAGING_DIRECTIVE = `android.packaging.jniLibs.keepDebugSymbols += [${ANDROID_RUNTIME_KEEP_DEBUG_SYMBOLS.map((pattern) => JSON.stringify(pattern)).join(", ")}]`;

/** Add the runtime policy without replacing unrelated JNI packaging settings. */
export function injectAndroidRuntimeBytePreservation(content) {
  if (!/\bandroid\s*\{/.test(content)) {
    throw new Error(
      "Android runtime packaging requires an android configuration block",
    );
  }
  if (
    content
      .split(/\r?\n/)
      .some((line) => line === ANDROID_RUNTIME_PACKAGING_DIRECTIVE)
  ) {
    return content;
  }
  // These executable payloads are hashed before Gradle runs. Stripping changes
  // their bytes and invalidates the runtime provenance embedded in the APK.
  return `${content.trimEnd()}\n\n// Preserve the exact native runtime bytes bound by APK provenance.\n${ANDROID_RUNTIME_PACKAGING_DIRECTIVE}\n`;
}
