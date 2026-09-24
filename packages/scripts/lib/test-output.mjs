/** Resolves generated test artifacts from the checkout, independently of the caller's working directory. */
import path from "node:path";

const outputRoot = path.resolve(import.meta.dirname, "../../../test-results");

export function testOutputPath(...segments) {
  return path.join(outputRoot, ...segments);
}
