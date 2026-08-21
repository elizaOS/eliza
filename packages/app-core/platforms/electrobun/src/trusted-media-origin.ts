/**
 * Return the one origin the native host may bypass Electrobun's redundant
 * page-level media prompt for. The signed app's macOS TCC grant still applies.
 * Anything except an explicit HTTP loopback port remains untrusted.
 */
export function resolveTrustedMediaCaptureOrigin(
  rendererUrl: string,
): string | null {
  try {
    const url = new URL(rendererUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "http:" || !loopback || !url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}
