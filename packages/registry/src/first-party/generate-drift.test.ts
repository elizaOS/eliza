/**
 * Drift gate for the committed first-party registry artifacts.
 *
 * `generate:first-party:check` has always been able to detect this, but its
 * doc comment calls it "the CI drift gate" and nothing ran it — the script was
 * referenced only by its own package.json definition. Two of the five
 * artifacts had no other guard: a stale `generated.json` (the canonical
 * first-party registry) or `curated-app-definitions.json` could merge with a
 * green build. The three derived maps were covered only incidentally, by
 * consistency assertions in other packages.
 *
 * This runs the shipped generator and compares its bytes to what is committed,
 * so the whole set is gated from inside the registry package's own suite.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { firstPartyArtifacts } from "./generate.ts";

const { artifacts } = firstPartyArtifacts();

describe("first-party generated artifacts", () => {
  it("emits all five committed artifacts", () => {
    expect(artifacts.map(([path]) => basename(path))).toEqual([
      "generated.json",
      "curated-app-definitions.json",
      "channel-plugin-map.json",
      "provider-plugin-map.json",
      "short-id-plugin-map.json",
    ]);
  });

  it.each(
    artifacts.map(([path, expected]) => [basename(path), path, expected]),
  )("%s is byte-identical to a fresh generation", (name, path, expected) => {
    expect(
      existsSync(path) && statSync(path).isFile(),
      `${name} is missing`,
    ).toBe(true);
    // Compared as bytes, not parsed JSON: the committed files must also
    // satisfy `format:check`, which key order and array wrapping affect.
    expect(
      readFileSync(path, "utf-8"),
      `${name} is stale — run \`bun run --cwd packages/registry generate:first-party\` and commit the result`,
    ).toBe(expected);
  });
});
