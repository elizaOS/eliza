/**
 * Unit tests for tool rename: validates quoted and escaped reverse replacements.
 */
import { describe, expect, it } from "vitest";
import type { Pair } from "./sanitize.ts";
import { applyQuotedRenames, applyQuotedRenamesReverse } from "./tool-rename.ts";

describe("tool-rename", () => {
  const pairs: ReadonlyArray<Pair> = [
    ["Bash", "cc_bash"],
    ["Edit", "cc_edit"],
  ];

  it("applies quoted renames on forward outgoing body", () => {
    const input = '{"tools":[{"name":"Bash"},{"name":"Edit"}]}';
    const output = applyQuotedRenames(input, pairs);
    expect(output).toBe('{"tools":[{"name":"cc_bash"},{"name":"cc_edit"}]}');
  });

  it("reverses quoted and escaped-quoted renames on incoming response", () => {
    const input = '{"name":"cc_bash","delta":"{"name":"cc_edit"}"}';
    const output = applyQuotedRenamesReverse(input, pairs);
    expect(output).toBe('{"name":"Bash","delta":"{"name":"Edit"}"}');
  });
});
