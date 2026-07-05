/**
 * Single source of truth for the mobile chat-reply FAILURE vocabulary.
 *
 * The mobile local-chat smoke (`mobile-local-chat-smoke.mjs`) and the on-device
 * iOS XCUITest reply verifier (`BootCaptureUITests.swift`) both need to classify
 * an agent reply that is actually an ERROR render (error boundary, "backend is
 * not running", think-tag leakage, …) as a FAILURE — never as a "genuine model
 * reply". Historically each side maintained its own copy of the list, which
 * drifted (issue #13687): the Swift heuristic only knew 5 warm-up phrases and
 * accepted an error render as a real reply.
 *
 * This module is the ONE checked-in list. `mobile-local-chat-smoke.mjs` derives
 * its `IOS_FULL_BUN_SMOKE_FAILURE_RE` / `ANDROID_FULL_TURN_FAILURE_RE` regexes
 * from here, and the generated Swift artifact
 * (`ChatFailureStrings.generated.swift`) is emitted from here so the XCUITest
 * bundle keys off the same vocabulary. A parity test
 * (`chat-failure-strings.test.mjs`) proves the derived regexes and the checked-in
 * Swift artifact stay in lockstep with this source.
 *
 *
 * Each entry is a RAW regex fragment (case-insensitive), so entries may carry
 * regex metacharacters (`\b`, `\s*`, `<`, …). Order is significant only for the
 * byte-for-byte reproduction of the pre-existing regex source; the classifier
 * semantics are order-independent (first alternative that matches wins, and
 * every alternative is a failure).
 */

import { pathToFileURL } from "node:url";

/**
 * Think-tag / no-think leakage fragments. A model that leaks its raw reasoning
 * scaffolding into the user-visible reply is a broken pipeline, not a reply.
 * Shared by the iOS and Android failure regexes.
 */
export const THINK_TAG_FAILURE_FRAGMENTS = Object.freeze([
  "<think\\b",
  "<\\/think>",
  "\\/?\\bno_think\\b",
]);

/**
 * iOS full-Bun smoke failure fragments (in the exact alternation order of the
 * historical `IOS_FULL_BUN_SMOKE_FAILURE_RE`). The trailing three fragments are
 * the shared think-tag group.
 */
export const IOS_FAILURE_FRAGMENTS = Object.freeze([
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
  ...THINK_TAG_FAILURE_FRAGMENTS,
]);

/**
 * Android full-turn failure fragments (in the exact alternation order of the
 * historical `ANDROID_FULL_TURN_FAILURE_RE`, plus the shared think-tag group
 * that used to be checked inline beside that regex).
 */
export const ANDROID_FAILURE_FRAGMENTS = Object.freeze([
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
  ...THINK_TAG_FAILURE_FRAGMENTS,
]);

/**
 * Build a case-insensitive alternation RegExp from an ordered list of raw
 * regex fragments. Behaviour-preserving reproduction of the hand-authored
 * source regexes.
 * @param {readonly string[]} fragments
 * @returns {RegExp}
 */
export function buildFailureRegExp(fragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) {
    throw new Error(
      "buildFailureRegExp requires a non-empty array of regex fragments",
    );
  }
  return new RegExp(fragments.join("|"), "i");
}

export const IOS_FULL_BUN_SMOKE_FAILURE_RE = buildFailureRegExp(
  IOS_FAILURE_FRAGMENTS,
);
export const ANDROID_FULL_TURN_FAILURE_RE = buildFailureRegExp(
  ANDROID_FAILURE_FRAGMENTS,
);

/**
 * Generate the deterministic contents of the checked-in Swift artifact
 * `ChatFailureStrings.generated.swift`, so the iOS XCUITest reply verifier can
 * classify a candidate reply against the SAME failure vocabulary as the mjs
 * smoke. The Swift verifier lowercases the fragment where it is a plain phrase
 * (no regex metacharacters) for a substring test; regex fragments are exposed
 * verbatim for an NSRegularExpression match. Keeping this generator here means
 * the parity test can assert the committed Swift file byte-matches this output.
 * @returns {string}
 */
export function renderSwiftFailureStrings() {
  const swiftArray = (name, fragments) => {
    const rows = fragments
      .map((f) => `        ${JSON.stringify(f)},`)
      .join("\n");
    return `    static let ${name}: [String] = [\n${rows}\n    ]`;
  };

  return `// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: packages/app/scripts/lib/chat-failure-strings.mjs
// Regenerate: node packages/app/scripts/lib/chat-failure-strings.mjs --emit-swift
// Parity guard: packages/app/scripts/lib/chat-failure-strings.test.mjs
//
// The mobile chat-reply FAILURE vocabulary shared with mobile-local-chat-smoke.mjs.
// A candidate XCUITest reply matching any of these is an error render / broken
// pipeline and must FAIL the attempt (never count as a "genuine model reply").

enum ChatFailureStrings {
${swiftArray("ios", IOS_FAILURE_FRAGMENTS)}

${swiftArray("android", ANDROID_FAILURE_FRAGMENTS)}
}
`;
}

/**
 * Generate the deterministic TypeScript artifact consumed by app-core and the
 * app renderer. This keeps browser/runtime smoke checks on the same vocabulary
 * without making app-core import from packages/app/scripts at runtime.
 * @returns {string}
 */
export function renderTypeScriptFailureStrings() {
  const tsArray = (name, fragments) => {
    const rows = fragments.map((f) => `  ${JSON.stringify(f)},`).join("\n");
    return `export const ${name} = [\n${rows}\n] as const;`;
  };

  return `// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: packages/app/scripts/lib/chat-failure-strings.mjs
// Regenerate: node packages/app/scripts/lib/chat-failure-strings.mjs --emit-ts
// Parity guard: packages/app/scripts/lib/chat-failure-strings.test.mjs

${tsArray("IOS_FAILURE_FRAGMENTS", IOS_FAILURE_FRAGMENTS)}

${tsArray("ANDROID_FAILURE_FRAGMENTS", ANDROID_FAILURE_FRAGMENTS)}

function buildFailureRegExp(fragments: readonly string[]): RegExp {
  return new RegExp(fragments.join("|"), "i");
}

export const IOS_FULL_BUN_SMOKE_FAILURE_RE = buildFailureRegExp(
  IOS_FAILURE_FRAGMENTS,
);

export const ANDROID_FULL_TURN_FAILURE_RE = buildFailureRegExp(
  ANDROID_FAILURE_FRAGMENTS,
);
`;
}

// Allow `node chat-failure-strings.mjs --emit-swift` to print the Swift artifact
// (used by the regenerate step + verified byte-for-byte by the parity test). The
// guard keeps a bare `import` of this module side-effect-free.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes("--emit-swift")) {
    process.stdout.write(renderSwiftFailureStrings());
  } else if (process.argv.includes("--emit-ts")) {
    process.stdout.write(renderTypeScriptFailureStrings());
  }
}
