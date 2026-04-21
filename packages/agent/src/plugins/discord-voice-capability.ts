/**
 * Discord voice capability detection.
 *
 * Checks whether the runtime environment has the system-level dependencies
 * (ffmpeg, opus bindings) required by @discordjs/voice and prism-media.
 * When deps are missing the discord plugin still loads — voice actions
 * return a user-friendly error instead of crashing.
 */

import { execFile } from "node:child_process";

/** Cached result so we only probe once per process. */
let cachedResult: VoiceCapability | undefined;
let probeOverrides: VoiceCapabilityProbeOverrides | undefined;

type VoiceCapabilityProbeOverrides = {
  checkFfmpeg?: () => Promise<boolean>;
  checkOpus?: () => Promise<boolean>;
};

export interface VoiceCapability {
  supported: boolean;
  ffmpeg: boolean;
  opus: boolean;
  details: string;
}

/** Check if ffmpeg is available on PATH. */
function checkFfmpeg(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], { timeout: 5_000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Check if an opus binding can be loaded. */
async function checkOpus(): Promise<boolean> {
  // Try @discordjs/opus first (native, fastest), then opusscript (wasm fallback).
  for (const pkg of ["@discordjs/opus", "opusscript"]) {
    try {
      await import(pkg);
      return true;
    } catch {
      // not available
    }
  }
  return false;
}

async function resolveFfmpegCheck(): Promise<boolean> {
  return (probeOverrides?.checkFfmpeg ?? checkFfmpeg)();
}

async function resolveOpusCheck(): Promise<boolean> {
  return (probeOverrides?.checkOpus ?? checkOpus)();
}

/** Probe the environment for voice support. Result is cached after first call. */
export async function detectVoiceCapability(): Promise<VoiceCapability> {
  if (cachedResult) return cachedResult;

  const [ffmpeg, opus] = await Promise.all([
    resolveFfmpegCheck(),
    resolveOpusCheck(),
  ]);
  const supported = ffmpeg && opus;

  const missing: string[] = [];
  if (!ffmpeg) missing.push("ffmpeg");
  if (!opus) missing.push("opus bindings (@discordjs/opus or opusscript)");

  const details = supported
    ? "Voice dependencies available"
    : `Missing: ${missing.join(", ")}`;

  cachedResult = { supported, ffmpeg, opus, details };
  return cachedResult;
}

/** Synchronous check after detection has run at least once. */
export function isVoiceSupported(): boolean {
  return cachedResult?.supported ?? false;
}

/** Get the cached capability result (undefined if detectVoiceCapability hasn't been called). */
export function getVoiceCapability(): VoiceCapability | undefined {
  return cachedResult;
}

/** Reset cached result (for testing). */
export function resetVoiceCapabilityCache(): void {
  cachedResult = undefined;
}

/** Override probes in tests so capability detection stays deterministic. */
export function setVoiceCapabilityProbeOverridesForTests(
  overrides?: VoiceCapabilityProbeOverrides,
): void {
  probeOverrides = overrides;
}

/**
 * Guard for voice channel actions. Returns an error string when voice is
 * unavailable, or `null` when the action can proceed.
 */
export function voiceActionGuard(): string | null {
  if (cachedResult && !cachedResult.supported) {
    return `Voice is not available in this environment. ${cachedResult.details}. The Discord bot will continue to work for text channels.`;
  }
  if (!cachedResult) {
    return "Voice capability has not been checked yet. Call detectVoiceCapability() first.";
  }
  return null;
}
