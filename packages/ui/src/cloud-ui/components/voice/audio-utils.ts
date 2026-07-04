/**
 * Feature-detection and small audio helpers (MediaRecorder support) for the voice surface.
 */
export function supportsMediaRecorder(): boolean {
  return typeof window !== "undefined" && "MediaRecorder" in window;
}

export function supportsGetUserMedia(): boolean {
  return !!(
    typeof window !== "undefined" &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia
  );
}

export function getSupportedMimeType(): string {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/wav",
  ];

  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return "";
}
