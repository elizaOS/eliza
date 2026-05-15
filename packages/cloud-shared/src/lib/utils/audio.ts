/**
 * Audio Utilities
 *
 * Helper functions for audio processing in browser
 */

/**
 * Convert audio Blob to base64 string
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      resolve(base64.split(",")[1] || base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Get duration of audio file
 */
export async function getAudioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.addEventListener("loadedmetadata", () => {
      URL.revokeObjectURL(url);
      resolve(audio.duration);
    });

    audio.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load audio"));
    });
  });
}

/**
 * Validate audio file
 */
export function validateAudioFile(
  file: File,
  options?: {
    maxSize?: number;
    allowedTypes?: string[];
  },
): { valid: boolean; error?: string } {
  const maxSize = options?.maxSize || 25 * 1024 * 1024; // 25MB default
  const allowedTypes = options?.allowedTypes || [
    "audio/mp3",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/wav",
    "audio/webm",
    "audio/ogg",
  ];

  if (file.size > maxSize) {
    return {
      valid: false,
      error: `File too large. Maximum size is ${maxSize / 1024 / 1024}MB`,
    };
  }

  if (!allowedTypes.includes(file.type)) {
    return {
      valid: false,
      error: `Unsupported audio format: ${file.type}`,
    };
  }

  return { valid: true };
}

/**
 * Create AudioContext with proper sample rate
 */
export function createAudioContext(sampleRate?: number): AudioContext {
  const contextOptions = sampleRate ? { sampleRate } : undefined;
  const audioWindow: Window & { webkitAudioContext?: typeof AudioContext } = window;
  const AudioContextClass = window.AudioContext || audioWindow.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("AudioContext is not supported in this browser");
  }
  return new AudioContextClass(contextOptions);
}

/**
 * Check if browser supports MediaRecorder
 */
export function supportsMediaRecorder(): boolean {
  return typeof window !== "undefined" && "MediaRecorder" in window;
}

/**
 * Check if browser supports getUserMedia
 */
export function supportsGetUserMedia(): boolean {
  return !!(
    typeof window !== "undefined" &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia
  );
}

/**
 * Get supported MIME type for MediaRecorder
 * Prioritizes audio-only formats to avoid video/webm containers on Safari/macOS
 */
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

  return ""; // Browser doesn't support any of these
}

/**
 * Convert audio blob to proper audio format if needed
 * Safari/macOS may create video/webm containers for audio recordings
 */
export async function ensureAudioFormat(blob: Blob): Promise<Blob> {
  // If it's already an audio format, return as-is
  if (blob.type.startsWith("audio/")) {
    return blob;
  }

  // If it's a video/webm that might contain audio, we need to convert it
  // For now, we'll just change the MIME type since it's actually audio data
  // The actual container is still WebM with audio track
  if (blob.type.startsWith("video/webm")) {
    return new Blob([blob], { type: "audio/webm" });
  }

  return blob;
}
