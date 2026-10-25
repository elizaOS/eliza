/**
 * Same-origin AudioWorklet entry points.
 *
 * `?no-inline` keeps Vite from converting these small modules to `data:` URLs;
 * browser CSPs can therefore load them under the normal same-origin
 * `script-src` policy. The package build copies the matching source directory
 * beside the compiled voice modules for non-Vite consumers.
 */

// Resolve only when voice starts so non-ESM fixture bundles can import the UI
// without evaluating their unsupported `import.meta.url` placeholder.
export function resolveAudioWorkletModuleUrl(
  kind: "uplink" | "downlink" | "playback-reference",
): string {
  switch (kind) {
    case "uplink":
      return new URL(
        "./worklets/voice-session-uplink.js?no-inline",
        import.meta.url,
      ).href;
    case "downlink":
      return new URL(
        "./worklets/voice-session-downlink.js?no-inline",
        import.meta.url,
      ).href;
    case "playback-reference":
      return new URL(
        "./worklets/playback-reference-tap.js?no-inline",
        import.meta.url,
      ).href;
  }
}
