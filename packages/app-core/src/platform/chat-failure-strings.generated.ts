// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: packages/app/scripts/lib/chat-failure-strings.mjs
// Regenerate: node packages/app/scripts/lib/chat-failure-strings.mjs --emit-ts
// Parity guard: packages/app/scripts/lib/chat-failure-strings.test.mjs

export const IOS_FAILURE_FRAGMENTS = [
  "something went wrong",
  "backend is not running",
  "local backend is not running",
  "no local backend",
  "no local model",
  "no model registered",
  "no provider",
  "connect a provider",
  "waiting for the model download",
  "timed out",
  "<think\\b",
  "<\\/think>",
  "\\/?\\bno_think\\b",
] as const;

export const ANDROID_FAILURE_FRAGMENTS = [
  "something went wrong",
  "no local gguf",
  "no local model",
  "no model registered",
  "no provider",
  "connect a provider",
  "device_disconnected",
  "device_timeout",
  "timed out",
  "chat generation failed",
  "waiting for the model download",
  "set chat routing",
  "progress:\\s*0%",
  "<think\\b",
  "<\\/think>",
  "\\/?\\bno_think\\b",
] as const;

function buildFailureRegExp(fragments: readonly string[]): RegExp {
  return new RegExp(fragments.join("|"), "i");
}

export const IOS_FULL_BUN_SMOKE_FAILURE_RE = buildFailureRegExp(
  IOS_FAILURE_FRAGMENTS,
);

export const ANDROID_FULL_TURN_FAILURE_RE = buildFailureRegExp(
  ANDROID_FAILURE_FRAGMENTS,
);
