/**
 * Feature-detection and small audio helpers (MediaRecorder support) for the voice surface.
 */
const REQUIRED_RECORDER_METHODS = [
  "addEventListener",
  "start",
  "stop",
  "pause",
  "resume",
] as const;

export function getMediaRecorderConstructor(): typeof MediaRecorder | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }

    const candidate = window.MediaRecorder;
    if (
      typeof candidate !== "function" ||
      typeof candidate.isTypeSupported !== "function" ||
      !candidate.prototype
    ) {
      return null;
    }

    // Reflect.construct checks whether the candidate is a constructor without
    // invoking browser code or requesting a real MediaStream.
    Reflect.construct(Function, [], candidate);

    return REQUIRED_RECORDER_METHODS.every(
      (method) => typeof candidate.prototype[method] === "function",
    )
      ? candidate
      : null;
  } catch {
    // error-policy:J3 Browser capability getters are untrusted input and fail closed.
    return null;
  }
}

export function isUsableMediaRecorder(
  candidate: unknown,
): candidate is MediaRecorder {
  try {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }

    return REQUIRED_RECORDER_METHODS.every(
      (method) =>
        typeof (candidate as Record<string, unknown>)[method] === "function",
    );
  } catch {
    // error-policy:J3 Hostile recorder instances are rejected as invalid input.
    return false;
  }
}

export function supportsMediaRecorder(): boolean {
  return getMediaRecorderConstructor() !== null;
}

export function supportsGetUserMedia(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function"
    );
  } catch {
    // error-policy:J3 Browser capability getters are untrusted input and fail closed.
    return false;
  }
}

export function getSupportedMimeType(
  recorder: typeof MediaRecorder | null = getMediaRecorderConstructor(),
): string {
  if (!recorder) {
    return "";
  }

  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/wav",
  ];

  try {
    for (const type of types) {
      if (recorder.isTypeSupported(type) === true) {
        return type;
      }
    }
  } catch {
    // error-policy:J3 MIME probing is browser input and fails closed.
    return "";
  }

  return "";
}
