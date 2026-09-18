/** Emits the Swift XCUITest fixture from the authored runtime vocabulary. */
import { pathToFileURL } from "node:url";
import {
  ANDROID_FAILURE_FRAGMENTS,
  IOS_FAILURE_FRAGMENTS,
} from "../../../app-core/src/platform/chat-failure-strings.ts";

export function renderSwiftFailureStrings() {
  const swiftArray = (name, fragments) => {
    const rows = fragments
      .map((f) => `        ${JSON.stringify(f)},`)
      .join("\n");
    return `    static let ${name}: [String] = [\n${rows}\n    ]`;
  };

  return `// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: packages/app-core/src/platform/chat-failure-strings.ts
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv.includes("--emit-swift")
) {
  process.stdout.write(renderSwiftFailureStrings());
}
